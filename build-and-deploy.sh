#!/bin/bash
# a8-claw — Build and Deploy
# Mirrors a8-code/build-and-deploy.sh exactly: Kubernetes Agent Sandbox CRDs
# (SandboxTemplate + SandboxWarmPool), dated image tag, manual warm-pool
# pod roll, health check.
#
# The one a8-claw-specific step is the platform-mcp pre-copy: the Dockerfile
# expects .platform-mcp-build/ to be inside the build context, so this
# script syncs ../platform-mcp/ in before `docker build`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="a8-claw"
NAMESPACE="aks-agentmesh-apps"
HEALTH_PORT="8040"

# ECR registry
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
AWS_REGION="${AWS_REGION:-us-west-2}"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${ECR_REGISTRY}/${SERVICE_NAME}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"

echo "=== Building ${SERVICE_NAME} ==="
echo "Registry: ${ECR_REGISTRY}"
echo "Tag: ${TAG}"

# ── Pre-flight: Check Agent Sandbox CRDs ────────────────────────────

echo "Checking Kubernetes Agent Sandbox CRDs..."
if ! kubectl api-resources 2>/dev/null | grep -q "sandboxtemplates"; then
    echo ""
    echo "⚠️  Agent Sandbox CRDs not found on cluster."
    echo "Install them first:"
    echo "  kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/agent-sandbox-crds.yaml"
    echo ""
    if [[ "${1:-}" != "--skip-crd-check" ]]; then
        echo "Run with --skip-crd-check to skip this check."
        exit 1
    fi
    echo "Skipping CRD check (--skip-crd-check)"
fi

# ── Check gVisor RuntimeClass ────────────────────────────────────────

echo "Checking gVisor RuntimeClass..."
if ! kubectl get runtimeclass gvisor >/dev/null 2>&1; then
    echo ""
    echo "⚠️  gVisor RuntimeClass 'gvisor' not found."
    echo "Continuing — pods will fail to schedule until gVisor is available, or"
    echo "edit sandbox-template.yaml to remove runtimeClassName for standard isolation."
fi

# ── Pre-build: sync platform-mcp into build context ─────────────────
# The Dockerfile does `COPY .platform-mcp-build/ /app/platform-mcp/`. We
# can't `COPY ../platform-mcp/` because the docker build context is rooted
# at SCRIPT_DIR. So we mirror the sibling dir into a build-only subfolder
# (gitignored).

PLATFORM_MCP_SRC="${SCRIPT_DIR}/../platform-mcp"
PLATFORM_MCP_DEST="${SCRIPT_DIR}/.platform-mcp-build"

if [[ ! -d "${PLATFORM_MCP_SRC}" ]]; then
    echo "ERROR: platform-mcp not found at ${PLATFORM_MCP_SRC}" >&2
    echo "Expected agentmesh/ layout with platform-mcp/ as a sibling of a8-claw/." >&2
    exit 1
fi

echo "Syncing platform-mcp into build context..."
rm -rf "${PLATFORM_MCP_DEST}"
# Exclude node_modules + dist + lockfiles; bun installs fresh inside the image.
rsync -a \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='*.log' \
    "${PLATFORM_MCP_SRC}/" "${PLATFORM_MCP_DEST}/"

# ── ECR auth + build ─────────────────────────────────────────────────

aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# Ensure ECR repo exists
aws ecr describe-repositories --repository-names "${SERVICE_NAME}" 2>/dev/null || \
    aws ecr create-repository --repository-name "${SERVICE_NAME}"

# Build — AMD64 for compute nodes (matches a8-code; warp is ARM64, claw isn't)
BUILD_FLAGS="--platform linux/amd64"
if [[ "${1:-}" == "--no-cache" ]] || [[ "${1:-}" == "--force" ]]; then
    BUILD_FLAGS="${BUILD_FLAGS} --no-cache"
fi

docker build ${BUILD_FLAGS} -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" "${SCRIPT_DIR}"

# Push
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

echo "=== Deploying ${SERVICE_NAME} ==="

# ── Apply Agent Sandbox CRDs ─────────────────────────────────────────

echo "Applying secrets and config..."
kubectl apply -f "${SCRIPT_DIR}/k8s/secrets-and-config.yaml" -n "${NAMESPACE}"

echo "Applying NetworkPolicy..."
kubectl apply -f "${SCRIPT_DIR}/k8s/network-policy.yaml" -n "${NAMESPACE}"

echo "Applying SandboxTemplate (image: ${IMAGE}:${TAG})..."
sed "s|${ECR_REGISTRY}/${SERVICE_NAME}:latest|${IMAGE}:${TAG}|g" \
    "${SCRIPT_DIR}/k8s/sandbox-template.yaml" | \
    kubectl apply -f - -n "${NAMESPACE}"

echo "Applying SandboxWarmPool..."
kubectl apply -f "${SCRIPT_DIR}/k8s/warm-pool.yaml" -n "${NAMESPACE}"

# ── Roll warm pool pods to the new image ─────────────────────────────
# SandboxWarmPool's reconciler does NOT roll pods when the template changes
# — it only acts when pod count drifts from spec.replicas. Without this
# step, the new image sits in ECR while existing pods continue running the
# old one indefinitely.

if [[ "$*" == *"--no-roll"* ]]; then
    echo "Skipping warm pool roll (--no-roll). Existing pods keep running the old image."
else
    echo "Rolling warm pool pods to ${IMAGE}:${TAG}..."

    DESIRED=$(kubectl get sandboxwarmpool -n "${NAMESPACE}" "${SERVICE_NAME}-warm-pool" \
        -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 3)
    [[ -z "${DESIRED}" ]] && DESIRED=3

    OLD_PODS=$(kubectl get pods -n "${NAMESPACE}" -o name 2>/dev/null \
        | grep "^pod/${SERVICE_NAME}-warm-pool-" || true)

    if [[ -n "${OLD_PODS}" ]]; then
        echo "${OLD_PODS}" | xargs kubectl delete -n "${NAMESPACE}" --wait=false
    else
        echo "No existing warm pool pods (cold start)."
    fi

    echo "Waiting for warm pool to reach ${DESIRED} pods on new image..."
    DEADLINE=$(($(date +%s) + 180))
    RUNNING_NEW=0
    while [[ $(date +%s) -lt ${DEADLINE} ]]; do
        RUNNING_NEW=$(kubectl get pods -n "${NAMESPACE}" \
            -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}' \
            2>/dev/null \
            | grep "^${SERVICE_NAME}-warm-pool-" \
            | grep -c "${IMAGE}:${TAG}" || true)
        printf "  Running on new image: %d / %d\n" "${RUNNING_NEW}" "${DESIRED}"
        if [[ "${RUNNING_NEW}" -ge "${DESIRED}" ]]; then
            echo "Warm pool fully rolled."
            break
        fi
        sleep 5
    done

    if [[ "${RUNNING_NEW}" -lt "${DESIRED}" ]]; then
        echo "WARN: warm pool did not reach ${DESIRED} pods on new image within 3 minutes." >&2
        echo "Current state:" >&2
        kubectl get pods -n "${NAMESPACE}" 2>/dev/null \
            | grep "^${SERVICE_NAME}-warm-pool-" >&2 || true
        echo "Investigate with: kubectl describe pod -n ${NAMESPACE} <pod-name>" >&2
    fi
fi

# ── Health check the rolled pods ─────────────────────────────────────

POD=$(kubectl get pods -n "${NAMESPACE}" -o name 2>/dev/null \
    | grep "^pod/${SERVICE_NAME}-warm-pool-" \
    | head -1 \
    | sed 's|^pod/||')
if [[ -n "${POD}" ]]; then
    echo "Health-checking ${POD} on port ${HEALTH_PORT}..."
    kubectl exec -n "${NAMESPACE}" "${POD}" -- curl -sf "http://localhost:${HEALTH_PORT}/health" \
        || echo "Health check pending (pod may still be starting)"
    echo
fi

echo ""
echo "=== ${SERVICE_NAME} deployed successfully ==="
echo "Image: ${IMAGE}:${TAG}"
echo "SandboxTemplate: ${SERVICE_NAME}-template"
echo "SandboxWarmPool: ${SERVICE_NAME}-warm-pool"
echo ""
echo "To check warm pool status:"
echo "  kubectl get sandboxwarmpool -n ${NAMESPACE}"
echo "  kubectl get pods -n ${NAMESPACE} | grep ${SERVICE_NAME}-warm-pool-"
