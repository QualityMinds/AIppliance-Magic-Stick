#!/usr/bin/env python3
"""Focused source and syntax tests for the embedded dashboard user-management UI."""

from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest


CONFIGMAP = Path(__file__).with_name("configmap.yaml")


def dashboard_source():
    return CONFIGMAP.read_text(encoding="utf-8")


def embedded_script(source):
    start = source.index("      <script>") + len("      <script>")
    end = source.index("      </script>", start)
    return textwrap.dedent(source[start:end])


def rendered_dashboard_html(source):
    """Reconstruct the HTML emitted by render.sh without running its loop."""
    first_marker = "      cat <<'HTML' > \"$tmp\"\n"
    second_marker = "      cat <<'HTML' >> \"$tmp\"\n"
    first_start = source.index(first_marker) + len(first_marker)
    first_end = source.index("\n    HTML", first_start)
    second_start = source.index(second_marker, first_end) + len(second_marker)
    second_end = source.index("\n    HTML", second_start)
    first = textwrap.dedent(source[first_start:first_end])
    second = textwrap.dedent(source[second_start:second_end])
    return first + "\nBrowser test render\n" + second


def chrome_executable():
    candidates = [
        shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return None


BROWSER_API_MOCK = r"""
(() => {
  const scenario = new URLSearchParams(window.location.search).get('scenario') || 'admin';
  const roleByScenario = {
    admin: ['magicstick-admin'],
    viewer: ['magicstick-viewer'],
    operator: ['magicstick-operator'],
    unavailable: ['magicstick-admin']
  };
  const managedRoles = {
    user: ['magicstick-user'],
    viewer: ['magicstick-user', 'magicstick-viewer'],
    operator: ['magicstick-user', 'magicstick-operator'],
    admin: ['magicstick-user', 'magicstick-admin']
  };
  let mockUser = null;
  let mockKubernetesUser = {
    id: 'kube-user-1',
    username: 'cluster-user',
    displayName: 'Cluster User',
    email: 'cluster.user@example.com',
    enabled: true,
    source: 'brokered',
    provider: 'entra',
    accessLevel: 'viewer',
    protected: false
  };
  let mockApiKeys = [{
    id: 'a'.repeat(64),
    name: 'Existing integration',
    keyHint: 'aaaaaaaaaa...aaaaaa',
    createdAt: '2026-09-02T10:00:00Z',
    expiresAt: '',
    status: 'active'
  }];
  window.__dashboardBrowserCalls = [];
  window.__dashboardClipboardWrites = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value) => {
        window.__dashboardClipboardWrites.push(String(value));
      }
    }
  });
  window.setInterval = () => 0;

  const capabilities = (enabled = true) => ({
    canEditProfile: true,
    canManageRoles: true,
    canEnable: !enabled,
    canDisable: enabled,
    canResetPassword: true,
    canDelete: true,
    isSelf: false,
    isProtected: false
  });
  const reply = (payload, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Mock error',
    json: async () => payload
  });

  window.fetch = async (rawPath, options = {}) => {
    const url = new URL(String(rawPath), window.location.href);
    const path = url.pathname + url.search;
    const method = String(options.method || 'GET').toUpperCase();
    let body = null;
    if (options.body) {
      try { body = JSON.parse(options.body); } catch (error) { body = options.body; }
    }
    window.__dashboardBrowserCalls.push({ path, method, headers: options.headers || {}, body });

    if (url.pathname === '/api/session') {
      return reply({
        subject: scenario + '-subject',
        username: scenario,
        roles: roleByScenario[scenario] || [],
        identityManagementAvailable: scenario !== 'unavailable',
        identityManagementMode: scenario === 'unavailable' ? 'external' : 'keycloak'
      });
    }
    if (url.pathname === '/api/settings') {
      return reply({
        publicDomain: 'magicstick.example.com',
        dashboardHost: 'magicstick.example.com',
        mdnsDomain: 'magicstick.local',
        mdnsName: 'magicstick'
      });
    }
    if (url.pathname === '/api/appliance') {
      return reply({ metadata: { namespace: 'ai-system', name: 'local' }, status: { phase: 'Ready' } });
    }
    if (url.pathname === '/api/modules') {
      return reply({
        modules: {
          litellm: {
            enabled: true,
            activationMode: 'moduleactivation',
            displayName: 'LiteLLM',
            status: { phase: 'Ready' }
          },
          'model-catalog': {
            enabled: true,
            activationMode: 'static',
            displayName: 'Model Catalog',
            status: { phase: 'Ready' }
          },
          'openclaw-operator': {
            enabled: true,
            activationMode: 'static',
            displayName: 'OpenClaw Operator',
            status: { phase: 'Ready' }
          },
          'hermes-operator': {
            enabled: true,
            activationMode: 'static',
            displayName: 'Hermes Operator',
            status: { phase: 'Ready' }
          },
          gpu: {
            enabled: true,
            activationMode: 'moduleactivation',
            displayName: 'NVIDIA GPU Operator',
            status: { phase: 'Ready', message: 'Applied revision: test' }
          }
        },
        catalogJson: {
          modules: {
            litellm: {
              displayName: 'LiteLLM',
              activationMode: 'moduleactivation',
              group: 'runtime',
              order: 50,
              credentials: { provider: 'litellm' }
            },
            gpu: {
              displayName: 'NVIDIA GPU Operator',
              activationMode: 'moduleactivation',
              activationPolicy: 'hardware-detected',
              group: 'operators',
              order: 30
            }
          },
          groups: {},
          applications: {
            openclaw: {
              displayName: 'OpenClaw',
              requiredModules: ['openclaw-operator', 'litellm', 'model-catalog']
            },
            hermes: {
              displayName: 'Hermes',
              requiredModules: ['hermes-operator', 'litellm', 'model-catalog']
            },
            paperclip: {
              displayName: 'Paperclip',
              requiredModules: ['paperclip-operator', 'agent-sandbox', 'litellm', 'model-catalog']
            }
          }
        }
      });
    }
    if (url.pathname === '/api/instances') {
      return reply({
        instances: {
          openclaw: [{
            metadata: { name: 'openclaw-demo' },
            spec: { application: 'openclaw', enabled: true },
            status: { phase: 'Ready' }
          }]
        }
      });
    }
    if (url.pathname === '/api/modules/litellm/credentials' && method === 'GET') {
      return reply({
        module: 'litellm',
        type: 'litellm',
        title: 'LiteLLM',
        namespace: 'ai',
        secretName: 'litellm-masterkey-secret',
        credentials: [
          { key: 'ui_username', value: 'admin' },
          { key: 'ui_password', value: 'sk-CHANGEME' }
        ]
      });
    }
    if (url.pathname === '/api/models') {
      return reply({
        models: [],
        activations: [{
          metadata: { name: 'installed-awq' },
          spec: {
            type: 'local',
            enabled: true,
            targetNamespace: 'ai',
            local: {
              preset: 'qwen3635b',
              artifact: 'awq-int4',
              computeTarget: 'nvidia-gpu',
              engine: 'VLLM',
              modelType: 'chat',
              vramMi: 18000,
              contextWindow: 32768,
              maxNumSeqs: 4
            }
          },
          status: { phase: 'Ready', computeTarget: 'nvidia-gpu', engine: 'VLLM' }
        }],
        presets: {
          qwen2505bcpu: {
            displayName: 'Qwen 2.5 0.5B CPU',
            variants: [
              {
                computeTarget: 'cpu',
                engine: 'VLLM',
                url: 'hf://Qwen/Qwen2.5-0.5B-Instruct',
                modelType: 'chat',
                contextWindow: 2048,
                maxNumSeqs: 1,
                memoryRequiredMi: 4096,
                defaultArtifact: 'int8',
                artifacts: [
                  {
                    id: 'bf16', title: 'BF16', precision: 'BF16', format: 'safetensors',
                    url: 'hf://Qwen/Qwen2.5-0.5B-Instruct', memoryRequiredMi: 4096
                  },
                  {
                    id: 'int8', title: 'INT8', precision: 'INT8', quantization: 'INT8', bits: 8,
                    format: 'safetensors', url: 'hf://example/qwen-cpu-int8', memoryRequiredMi: 2500
                  }
                ]
              },
              {
                computeTarget: 'cpu',
                engine: 'OLlama',
                url: 'ollama://qwen2.5:0.5b',
                modelType: 'chat',
                contextWindow: 2048,
                maxNumSeqs: 1,
                memoryRequiredMi: 2048,
                defaultArtifact: 'q4-k-m',
                artifacts: [
                  {
                    id: 'q4-k-m', title: 'GGUF Q4_K_M', precision: 'INT4', quantization: 'Q4_K_M', bits: 4,
                    format: 'GGUF', url: 'ollama://qwen2.5:0.5b', memoryRequiredMi: 2048
                  },
                  {
                    id: 'q8-0', title: 'GGUF Q8_0', precision: 'INT8', quantization: 'Q8_0', bits: 8,
                    format: 'GGUF', url: 'ollama://qwen2.5:0.5b-instruct-q8_0', memoryRequiredMi: 2600
                  }
                ]
              },
              {
                computeTarget: 'nvidia-gpu',
                engine: 'OLlama',
                url: 'ollama://qwen2.5:0.5b',
                modelType: 'chat',
                contextWindow: 2048,
                maxNumSeqs: 1,
                vramMi: 2048
              }
            ]
          },
          qwen3635b: {
            displayName: 'Qwen 3.6 35B NVIDIA',
            variants: [{
              computeTarget: 'nvidia-gpu',
              engine: 'VLLM',
              url: 'hf://example/qwen-gpu',
              modelType: 'chat',
              vramMi: 46000,
              defaultArtifact: 'awq-int4',
              artifacts: [
                {
                  id: 'bf16', title: 'BF16', precision: 'BF16', format: 'safetensors',
                  url: 'hf://example/qwen-gpu-bf16', vramMi: 46000
                },
                {
                  id: 'awq-int4', title: 'AWQ INT4', precision: 'INT4', quantization: 'AWQ', bits: 4,
                  format: 'safetensors', url: 'hf://example/qwen-gpu-awq', vramMi: 18000,
                  compatibilityNote: 'Requires compatible accelerator instructions.'
                }
              ]
            }]
          }
        },
        computeTargets: {
          default: 'cpu',
          targets: [
            { id: 'cpu', kind: 'cpu', displayName: 'CPU', engines: ['VLLM', 'OLlama'], available: true, message: 'Ready on 1 compatible node.' },
            { id: 'nvidia-gpu', kind: 'gpu', displayName: 'NVIDIA GPU', engines: ['VLLM', 'OLlama'], available: true, message: '1 allocatable NVIDIA GPU resource is available.' },
            { id: 'amd-gpu', kind: 'gpu', displayName: 'AMD GPU (ROCm)', engines: ['VLLM', 'OLlama'], available: false, message: 'No AMD GPU detected.' },
            { id: 'intel-gpu', kind: 'gpu', displayName: 'Intel GPU (XPU)', engines: ['VLLM'], available: false, message: 'No Intel GPU detected.' }
          ]
        },
        vram: { available: false },
        computeMemory: {
          deviceCount: 2,
          metricsComplete: true,
          devices: [
            {
              id: 'cpu', kind: 'cpu', vendor: 'generic', computeTarget: 'cpu', name: 'CPU',
              totalMi: 16384, reservedMi: 4096, unreservedMi: 12288,
              freeMi: 10240, metricsAvailable: true, metricsSource: 'kubelet'
            },
            {
              id: 'nvidia-GPU-1', kind: 'gpu', vendor: 'nvidia', computeTarget: 'nvidia-gpu', name: 'NVIDIA Test GPU',
              totalMi: 24576, reservedMi: 8192, unreservedMi: 16384,
              freeMi: 18432, metricsAvailable: true, metricsSource: 'dcgm'
            }
          ]
        }
      });
    }
    if (url.pathname === '/api/model-discovery/search' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const cursor = url.searchParams.get('cursor') || '0';
      const firstPage = cursor === '0';
      return reply({
        provider: 'huggingface',
        query,
        normalizedQueries: [query, query.replace(/\s+/g, '')],
        results: firstPage ? [
          {
            id: 'Qwen/Qwen3.6-27B', repo: 'Qwen/Qwen3.6-27B', label: 'Qwen 3.6 27B',
            url: 'hf://Qwen/Qwen3.6-27B', author: 'Qwen', name: 'Qwen3.6-27B', revision: 'a'.repeat(40),
            pipelineTag: 'text-generation', libraryName: 'transformers', formats: ['safetensors'],
            parameterCount: 27000000000, weightBytes: 54000000000, quantization: null,
            trustStatus: 'official', compatibility: 'compatible', baseModels: []
          },
          {
            id: 'Qwen/Qwen3.6-9B', repo: 'Qwen/Qwen3.6-9B', label: 'Qwen 3.6 9B',
            url: 'hf://Qwen/Qwen3.6-9B', author: 'Qwen', name: 'Qwen3.6-9B', revision: 'b'.repeat(40),
            pipelineTag: 'text-generation', libraryName: 'transformers', formats: ['safetensors'],
            parameterCount: 9000000000, weightBytes: 18000000000, quantization: null,
            trustStatus: 'official', compatibility: 'experimental', baseModels: []
          },
          {
            id: 'example/Qwen3.6-27B-GGUF', repo: 'example/Qwen3.6-27B-GGUF', label: 'Qwen 3.6 27B GGUF',
            url: 'hf://example/Qwen3.6-27B-GGUF', author: 'example', name: 'Qwen3.6-27B-GGUF',
            pipelineTag: 'text-generation', formats: ['gguf'], weightBytes: 15000000000,
            quantization: { method: 'Q4_K_M', bits: 4, label: 'GGUF Q4_K_M' },
            trustStatus: 'community', compatibility: 'incompatible', baseModels: ['Qwen/Qwen3.6-27B']
          }
        ] : [
          {
            id: 'Qwen/Qwen3.6-9B', repo: 'Qwen/Qwen3.6-9B', label: 'Qwen 3.6 9B duplicate',
            url: 'hf://Qwen/Qwen3.6-9B', author: 'Qwen', name: 'Qwen3.6-9B',
            pipelineTag: 'text-generation', formats: ['safetensors'], parameterCount: 9000000000,
            trustStatus: 'official', compatibility: 'experimental', baseModels: []
          },
          {
            id: 'Qwen/Qwen3.6-35B-A3B', repo: 'Qwen/Qwen3.6-35B-A3B', label: 'Qwen 3.6 35B A3B',
            url: 'hf://Qwen/Qwen3.6-35B-A3B', author: 'Qwen', name: 'Qwen3.6-35B-A3B',
            pipelineTag: 'text-generation', formats: ['safetensors'], parameterCount: 35000000000,
            weightBytes: 70000000000, trustStatus: 'official', compatibility: 'compatible', baseModels: []
          }
        ],
        total: 4,
        cursor,
        nextCursor: firstPage ? '3' : null
      });
    }
    if (url.pathname === '/api/model-discovery/popular' && method === 'GET') {
      return reply({
        provider: 'huggingface',
        source: 'trendingScore',
        results: [
          {
            id: 'zai-org/GLM-5.3', repo: 'zai-org/GLM-5.3', author: 'zai-org', name: 'GLM-5.3',
            pipelineTag: 'text-generation', formats: ['safetensors'], trendingScore: 500,
            trustStatus: 'community', compatibility: 'experimental'
          },
          {
            id: 'Qwen/Qwen3.8-27B', repo: 'Qwen/Qwen3.8-27B', author: 'Qwen', name: 'Qwen3.8-27B',
            pipelineTag: 'image-text-to-text', formats: ['safetensors'], trendingScore: 450,
            trustStatus: 'official', compatibility: 'experimental'
          }
        ],
        total: 2,
        cursor: '0',
        nextCursor: null
      });
    }
    if (url.pathname === '/api/model-discovery/artifacts' && method === 'GET') {
      const repo = url.searchParams.get('repo') || '';
      const cursor = url.searchParams.get('cursor') || '0';
      const firstPage = cursor === '0';
      return reply({
        provider: 'huggingface',
        baseModel: repo,
        artifacts: firstPage ? [
          {
            id: repo, repo, label: 'Original BF16', url: 'hf://' + repo, author: repo.split('/')[0],
            name: repo.split('/').pop(), revision: 'a'.repeat(40), pipelineTag: 'text-generation',
            formats: ['safetensors'], parameterCount: 27000000000, weightBytes: 54000000000,
            quantization: null, trustStatus: 'official', compatibility: 'compatible',
            relation: 'selected', discoverySource: 'selected', original: true
          },
          {
            id: 'community/Qwen3.6-27B-AWQ', repo: 'community/Qwen3.6-27B-AWQ', label: 'AWQ INT4',
            url: 'hf://community/Qwen3.6-27B-AWQ', author: 'community', name: 'Qwen3.6-27B-AWQ',
            revision: 'c'.repeat(40), pipelineTag: 'text-generation', formats: ['safetensors'],
            parameterCount: 27000000000, weightBytes: 15000000000,
            quantization: { method: 'AWQ', bits: 4, label: 'AWQ' },
            trustStatus: 'community', compatibility: 'compatible', baseModels: [repo],
            relation: 'quantized', discoverySource: 'base-model', original: false
          }
        ] : [
          {
            id: 'community/Qwen3.6-27B-AWQ', repo: 'community/Qwen3.6-27B-AWQ', label: 'AWQ duplicate',
            url: 'hf://community/Qwen3.6-27B-AWQ', author: 'community', name: 'Qwen3.6-27B-AWQ',
            formats: ['safetensors'], quantization: { method: 'AWQ', bits: 4, label: 'AWQ' },
            trustStatus: 'community', compatibility: 'compatible', baseModels: [repo], original: false
          },
          {
            id: 'community/Qwen3.6-27B-GPTQ', repo: 'community/Qwen3.6-27B-GPTQ', label: 'GPTQ INT4',
            url: 'hf://community/Qwen3.6-27B-GPTQ', author: 'community', name: 'Qwen3.6-27B-GPTQ',
            formats: ['safetensors'], weightBytes: 14500000000,
            quantization: { method: 'GPTQ', bits: 4, label: 'GPTQ' },
            trustStatus: 'community', compatibility: 'experimental', baseModels: [repo], original: false
          }
        ],
        total: 3,
        cursor,
        nextCursor: firstPage ? '2' : null
      });
    }
    if (url.pathname === '/api/status') {
      return reply({
        fluxKustomizations: [],
        pods: [],
        services: [],
        ingresses: [],
        httpRoutes: [
          {
            namespace: 'identity-system',
            name: 'static-litellm-local',
            labels: {},
            hostnames: ['litellm.magicstick.local'],
            accepted: true
          },
          {
            namespace: 'identity-system',
            name: 'static-litellm-local-callback',
            labels: {},
            hostnames: ['magicstick.local'],
            accepted: true
          },
          {
            namespace: 'identity-system',
            name: 'openclaw-demo-local',
            labels: { 'appliance.magicstick.dev/appinstance': 'openclaw-demo' },
            hostnames: ['demo.openclaw.magicstick.local'],
            accepted: true
          },
          {
            namespace: 'identity-system',
            name: 'static-litellm-pending',
            labels: { 'app.kubernetes.io/name': 'litellm' },
            hostnames: ['pending.magicstick.example.com'],
            accepted: false
          }
        ],
        hardwareOperators: {
          gpu: {
            module: 'gpu', displayName: 'NVIDIA GPU Operator', vendor: 'nvidia',
            operatorVersion: 'v26.3.3', driverMode: 'operator-managed', phase: 'Ready',
            needed: true, operatorActive: true, managedBy: 'magicstick', detectedNodes: ['gpu-node'],
            compatibleNodes: ['gpu-node'], allocatableResources: 1,
            message: '1 allocatable GPU resource is ready.'
          },
          'amd-gpu': {
            module: 'amd-gpu', displayName: 'AMD GPU Operator', vendor: 'amd',
            operatorVersion: 'v1.5.1', driverMode: 'host-driver', phase: 'Installing',
            needed: true, operatorActive: true, managedBy: 'magicstick', detectedNodes: ['amd-node'],
            compatibleNodes: ['amd-node'], allocatableResources: 0,
            message: 'The driver and device plugin are starting.'
          },
          'intel-gpu': {
            module: 'intel-gpu', displayName: 'Intel GPU Operator', vendor: 'intel',
            operatorVersion: '0.36.0', driverMode: 'kernel-driver', phase: 'Ready',
            needed: true, operatorActive: true, managedBy: 'magicstick', detectedNodes: ['intel-node'],
            compatibleNodes: ['intel-node'], allocatableResources: 1,
            message: '1 allocatable GPU resource is ready.'
          }
        },
        events: []
      });
    }
    if (url.pathname === '/api/models/estimate-memory' && method === 'POST') {
      const cpu = body.computeTarget === 'cpu';
      const ollama = body.engine === 'OLlama';
      const minimumMi = cpu ? (ollama ? 1120 : 3072) : (ollama ? 1120 : 18000);
      const recommendedMi = cpu ? (ollama ? 1632 : 4096) : (ollama ? 1632 : 24000);
      return reply({
        repo: ollama ? 'library/qwen2.5:0.5b' : String(body.url || '').replace(/^hf:\/\//, ''),
        engine: body.engine, computeTarget: body.computeTarget,
        memoryKind: cpu ? 'ram' : 'vram',
        minimumMi, recommendedMi, maximumMi: cpu ? null : 12288,
        weightsMi: ollama ? 384 : 14000,
        downloadBytes: ollama ? 0 : 15000000000,
        downloadSizeSource: ollama ? '' : 'huggingface-used-storage',
        kvCacheMi: ollama ? 256 : 2000,
        reserveMi: ollama ? 480 : 2000,
        recommendedReserveMi: ollama ? 512 : 6000,
        modelMaxContext: ollama ? 0 : 262144,
        contextWindow: body.contextWindow || 8192, maxNumSeqs: body.maxNumSeqs || 32,
        confidence: ollama ? 'estimated' : 'high', gpuAvailable: !cpu, warnings: []
      });
    }
    if (url.pathname === '/api/models/local' && method === 'POST') {
      return reply({ requested: body.name, type: 'local' });
    }
    if (url.pathname === '/api/models/external' && method === 'POST') {
      return reply({ requested: body.name, type: 'external' });
    }
    if (url.pathname === '/api/api-access' && method === 'GET') {
      return reply({
        items: mockApiKeys,
        total: mockApiKeys.length,
        apiBases: [
          { scope: 'local', url: 'https://litellm.magicstick.local/v1' },
          { scope: 'public', url: 'https://litellm.magicstick.example.com/v1' }
        ]
      });
    }
    if (url.pathname === '/api/api-access' && method === 'POST') {
      const item = {
        id: 'b'.repeat(64),
        name: body.name,
        keyHint: 'bbbbbbbbbb...bbbbbb',
        createdAt: '2026-09-02T10:15:00Z',
        expiresAt: '',
        status: 'active'
      };
      mockApiKeys = [item, ...mockApiKeys];
      return reply({
        item,
        key: 'sk-BROWSER-ONE-TIME-CHANGEME',
        apiBases: [{ scope: 'local', url: 'https://litellm.magicstick.local/v1' }]
      }, 201);
    }
    if (url.pathname.startsWith('/api/api-access/') && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      mockApiKeys = mockApiKeys.filter((item) => item.id !== id);
      return reply({ deleted: id });
    }
    if (url.pathname === '/api/kubernetes-access' && method === 'GET') {
      return reply({
        users: [mockKubernetesUser],
        total: 1,
        first: 0,
        max: 100,
        configuration: {
          configured: true,
          issuerUrl: 'https://id.magicstick.local/realms/magicstick',
          clientId: 'magicstick-kubernetes',
          apiServer: 'https://magicstick.local:6443',
          credentialPlugin: 'kubectl oidc-login'
        }
      });
    }
    if (url.pathname === '/api/kubernetes-access/kube-user-1' && method === 'PUT') {
      mockKubernetesUser = { ...mockKubernetesUser, accessLevel: body.accessLevel };
      return reply(mockKubernetesUser);
    }
    if (url.pathname === '/api/kubernetes-access/kube-user-1/kubeconfig' && method === 'GET') {
      return reply({
        filename: 'magicstick-cluster-user.kubeconfig',
        accessLevel: mockKubernetesUser.accessLevel,
        content: 'apiVersion: v1\nkind: Config\nusers: []\n'
      });
    }
    if (url.pathname === '/api/users' && method === 'GET') {
      return reply({ users: mockUser ? [mockUser] : [], total: mockUser ? 1 : 0, first: 0, max: 25 });
    }
    if (url.pathname === '/api/users/u-1' && method === 'GET') {
      return reply(mockUser || { error: 'not found' }, mockUser ? 200 : 404);
    }
    if (url.pathname === '/api/users' && method === 'POST') {
      mockUser = {
        id: 'u-1',
        username: body.username,
        firstName: body.firstName,
        lastName: body.lastName,
        displayName: [body.firstName, body.lastName].filter(Boolean).join(' '),
        email: body.email,
        emailVerified: false,
        enabled: body.enabled,
        createdAt: 1700000000000,
        source: 'local',
        provider: 'local',
        directRoles: managedRoles[body.accessLevel],
        effectiveRoles: managedRoles[body.accessLevel],
        accessLevel: body.accessLevel,
        effectiveAccessLevel: body.accessLevel,
        capabilities: capabilities(body.enabled)
      };
      return reply(mockUser, 201);
    }
    if (url.pathname === '/api/users/u-1' && method === 'PATCH') {
      Object.assign(mockUser, body, {
        displayName: [body.firstName, body.lastName].filter(Boolean).join(' ')
      });
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/roles' && method === 'PUT') {
      mockUser.accessLevel = body.accessLevel;
      mockUser.effectiveAccessLevel = body.accessLevel;
      mockUser.directRoles = managedRoles[body.accessLevel];
      mockUser.effectiveRoles = managedRoles[body.accessLevel];
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/disable' && method === 'POST') {
      mockUser.enabled = false;
      mockUser.capabilities = capabilities(false);
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/enable' && method === 'POST') {
      mockUser.enabled = true;
      mockUser.capabilities = capabilities(true);
      return reply(mockUser);
    }
    if (url.pathname === '/api/users/u-1/password' && method === 'PUT') {
      return reply({ id: 'u-1', passwordReset: true, temporary: true });
    }
    if (url.pathname === '/api/users/u-1' && method === 'DELETE') {
      if (!body || body.usernameConfirmation !== mockUser.username) {
        return reply({ error: 'username confirmation is invalid' }, 400);
      }
      mockUser = null;
      return reply({ deleted: 'u-1' });
    }
    return reply({ error: 'unmocked request: ' + method + ' ' + url.pathname }, 404);
  };
})();
"""


BROWSER_ASSERTIONS = r"""
(() => {
  const result = document.createElement('pre');
  result.id = 'browser-test-result';
  result.dataset.status = 'running';
  document.body.appendChild(result);
  const scenario = new URLSearchParams(window.location.search).get('scenario') || 'admin';
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (predicate, message, attempts = 300) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) { return; }
      await sleep(10);
    }
    throw new Error('Timed out: ' + message);
  };
  const assert = (condition, message) => {
    if (!condition) { throw new Error(message); }
  };
  const callExists = (method, path) => window.__dashboardBrowserCalls.some((call) => call.method === method && call.path.split('?')[0] === path);
  const memoryEstimateCallExists = (engine, computeTarget) => window.__dashboardBrowserCalls.some((call) => (
    call.method === 'POST'
    && call.path.split('?')[0] === '/api/models/estimate-memory'
    && call.body.engine === engine
    && call.body.computeTarget === computeTarget
  ));
  const actionButton = async (action) => {
    await waitFor(() => {
      const button = document.querySelector('[data-user-action="' + action + '"]');
      return button && !button.disabled;
    }, action + ' action');
    return document.querySelector('[data-user-action="' + action + '"]');
  };

  (async () => {
    await waitFor(() => document.getElementById('session-user').textContent.includes('Signed in: '), 'dashboard refresh');
    await waitFor(() => document.querySelectorAll('.overview-url-link').length === 2, 'overview URLs');
    const overviewUrls = Array.from(document.querySelectorAll('.overview-url-link')).map((link) => link.textContent);
    assert(overviewUrls.includes('https://litellm.magicstick.local'), 'module URL is missing');
    assert(overviewUrls.includes('https://demo.openclaw.magicstick.local'), 'instance URL is missing');
    assert(!overviewUrls.includes('https://magicstick.local'), 'OIDC callback route leaked into module URLs');
    assert(!overviewUrls.includes('https://pending.magicstick.example.com'), 'unaccepted HTTPRoute was shown');
    assert(document.getElementById('overview-app-count').textContent === '2 URLs', 'overview URL count is incorrect');

    assert(!document.querySelector('[data-tab="modules"]'), 'legacy Modules tab is still visible');
    assert(!document.querySelector('[data-tab="instances"]'), 'legacy Instances tab is still visible');
    document.querySelector('[data-tab="services"]').click();
    await waitFor(() => !document.getElementById('tab-services').hidden, 'Services tab');
    assert(!document.getElementById('tab-services').textContent.includes('Enable and wait for:'), 'technical dependency message is visible on the Services page');
    const nvidiaService = document.querySelector('[data-module="gpu"]') || Array.from(document.querySelectorAll('.service-module-row')).find((item) => item.textContent.includes('NVIDIA GPU Operator'));
    assert(nvidiaService, 'NVIDIA GPU Operator service is missing');
    assert(nvidiaService.textContent.includes('Installing'), 'NVIDIA service reports Ready before telemetry is available');
    assert(nvidiaService.textContent.includes('waiting for DCGM telemetry'), 'NVIDIA service does not explain its pending telemetry');
    assert(!nvidiaService.textContent.includes('Applied revision: test'), 'Flux readiness leaked into the NVIDIA service state');
    const openClawService = document.querySelector('[data-service-application="openclaw"]');
    assert(openClawService, 'OpenClaw application service is missing');
    assert(openClawService.querySelectorAll('.service-instance-card').length === 1, 'OpenClaw instance is not nested below its application');
    assert(openClawService.textContent.includes('openclaw-demo'), 'nested OpenClaw instance name is missing');
    const openClawInstancesToggle = openClawService.querySelector('[data-service-instances-toggle="openclaw"]');
    const openClawInstancesList = openClawService.querySelector('[data-service-instances-list="openclaw"]');
    assert(openClawInstancesToggle && openClawInstancesList, 'OpenClaw instance collapse controls are missing');
    assert(openClawInstancesToggle.closest('.service-module-identity'), 'instance toggle is not beside the module instance count');
    assert(!openClawService.textContent.includes('configured instance'), 'duplicate configured-instance summary is still visible');
    assert(openClawInstancesList.hidden, 'application instances must start collapsed');
    assert(openClawInstancesToggle.getAttribute('aria-expanded') === 'false', 'collapsed instance toggle state is incorrect');
    assert(openClawInstancesToggle.querySelector('[data-service-instances-toggle-icon]').textContent === '▸', 'collapsed instance arrow is incorrect');
    openClawInstancesToggle.click();
    assert(!openClawInstancesList.hidden, 'instance toggle did not expand the nested instances');
    assert(openClawInstancesToggle.textContent.includes('Hide'), 'expanded instance toggle label is incorrect');
    assert(openClawInstancesToggle.querySelector('[data-service-instances-toggle-icon]').textContent === '▾', 'expanded instance arrow is incorrect');
    await window.__dashboardRefresh();
    const refreshedOpenClawService = document.querySelector('[data-service-application="openclaw"]');
    const refreshedOpenClawInstancesToggle = refreshedOpenClawService.querySelector('[data-service-instances-toggle="openclaw"]');
    const refreshedOpenClawInstancesList = refreshedOpenClawService.querySelector('[data-service-instances-list="openclaw"]');
    assert(!refreshedOpenClawInstancesList.hidden, 'expanded instance state was lost during dashboard refresh');
    refreshedOpenClawInstancesToggle.click();
    assert(refreshedOpenClawInstancesList.hidden, 'instance toggle did not collapse the nested instances');
    assert(refreshedOpenClawInstancesToggle.textContent.includes('Show'), 'collapsed instance toggle label is incorrect');
    assert(document.getElementById('service-platform-list').hidden, 'platform details must start collapsed');
    assert(document.getElementById('service-platform-toggle').getAttribute('aria-expanded') === 'false', 'platform toggle state is incorrect');
    document.querySelector('[data-service-filter="platform"]').click();
    assert(document.querySelector('[data-service-section="applications"]').hidden, 'application section remained visible under platform filter');
    assert(!document.querySelector('[data-service-section="platform"]').hidden, 'platform section is hidden under platform filter');
    assert(!document.getElementById('service-platform-list').hidden, 'platform filter did not expand technical modules');
    document.getElementById('service-platform-toggle').click();
    assert(document.getElementById('service-platform-list').hidden, 'platform toggle did not collapse technical modules');
    document.querySelector('[data-service-filter="all"]').click();
    assert(!document.querySelector('[data-service-section="applications"]').hidden, 'application section did not return under All filter');
    const moduleCredentials = document.querySelector('[data-module-credentials="litellm"]');
    const canReadCredentials = ['admin', 'operator', 'unavailable'].includes(scenario);
    if (canReadCredentials) {
      assert(moduleCredentials, scenario + ' cannot see LiteLLM credentials');
      moduleCredentials.click();
      await waitFor(() => callExists('GET', '/api/modules/litellm/credentials'), 'LiteLLM credentials request');
      await waitFor(() => moduleCredentials.textContent === 'Hide credentials', 'LiteLLM credentials panel');
      const credentialValues = Array.from(moduleCredentials.closest('.module-card').querySelectorAll('.credential-value input')).map((input) => input.value);
      assert(credentialValues.includes('admin'), 'LiteLLM UI username is missing');
      assert(credentialValues.includes('sk-CHANGEME'), 'LiteLLM UI password is missing');
    } else {
      assert(!moduleCredentials, scenario + ' must not see LiteLLM credentials');
      assert(!callExists('GET', '/api/modules/litellm/credentials'), 'hidden LiteLLM credentials were requested');
    }

    const directHermesCreate = document.querySelector('[data-service-application="hermes"] [data-instance-create="hermes"]');
    assert(directHermesCreate, 'direct Hermes create action is missing');
    directHermesCreate.click();
    const directDialog = document.getElementById('instance-create-dialog');
    await waitFor(() => directDialog.open && !document.getElementById('instance-config-step').hidden, 'direct Hermes configuration');
    assert(!document.querySelector('.instance-form[data-instance-type="hermes"]').hidden, 'direct create did not select Hermes');
    assert(document.getElementById('instance-type-step').hidden, 'type picker remained visible for direct create');
    directDialog.querySelector('[data-dialog-cancel]').click();
    await waitFor(() => !directDialog.open, 'close direct create dialog');

    const createInstance = document.getElementById('instance-create-open');
    assert(createInstance && !createInstance.hidden && !createInstance.closest('[hidden]'), 'Create Instance button is not visible');
    createInstance.click();
    const instanceDialog = document.getElementById('instance-create-dialog');
    await waitFor(() => instanceDialog.open, 'instance create dialog');
    const choices = Array.from(document.querySelectorAll('[data-instance-choice]'));
    assert(choices.length === 3, 'instance picker must show every catalogued type');
    assert(choices.map((choice) => choice.dataset.instanceChoice).join(',') === 'openclaw,hermes,paperclip', 'instance picker types are incorrect');
    const paperclipChoice = document.querySelector('[data-instance-choice="paperclip"]');
    assert(paperclipChoice.disabled, 'Paperclip must remain disabled while required modules are missing');
    assert(paperclipChoice.textContent.includes('Paperclip Operator'), 'Paperclip does not identify its missing operator');
    assert(paperclipChoice.textContent.includes('Agent Sandbox'), 'Paperclip does not identify its missing sandbox module');
    assert(Array.from(document.querySelectorAll('.instance-form')).every((form) => form.hidden), 'configuration forms are visible before selecting a type');
    await sleep(20);
    assert(document.activeElement === choices[0], 'instance picker did not receive focus');

    document.querySelector('[data-instance-choice="hermes"]').click();
    await waitFor(() => !document.getElementById('instance-config-step').hidden, 'Hermes configuration step');
    const hermesForm = document.querySelector('.instance-form[data-instance-type="hermes"]');
    const openClawForm = document.querySelector('.instance-form[data-instance-type="openclaw"]');
    assert(!hermesForm.hidden, 'selected Hermes form is hidden');
    assert(openClawForm.hidden, 'unselected OpenClaw form is visible');
    assert(Array.from(document.querySelectorAll('.instance-form')).filter((form) => !form.hidden).length === 1, 'more than one instance form is visible');
    assert(document.getElementById('instance-selected-type').textContent === 'Hermes configuration', 'selected type heading is incorrect');
    assert(!document.getElementById('instance-create-back'), 'Back to types is still visible');
    instanceDialog.querySelector('[data-dialog-cancel]').click();
    await waitFor(() => !instanceDialog.open, 'close instance create dialog');

    document.querySelector('[data-tab="models"]').click();
    await waitFor(() => !document.getElementById('tab-models').hidden, 'Models tab');
    await waitFor(() => document.querySelectorAll('.memory-gauge').length === 2, 'compute memory gauges');
    assert(!document.getElementById('vram-summary'), 'legacy NVIDIA VRAM summary is still present');
    assert(!document.getElementById('vram-list'), 'legacy NVIDIA VRAM list is still present');
    const cpuGauge = document.querySelector('[data-memory-device="cpu"]');
    const gpuGauge = document.querySelector('[data-memory-device="nvidia-GPU-1"]');
    assert(cpuGauge && cpuGauge.textContent.includes('CPU'), 'CPU memory gauge is missing');
    assert(gpuGauge && gpuGauge.textContent.includes('NVIDIA Test GPU'), 'per-GPU memory gauge is missing');
    assert(cpuGauge.querySelector('[data-memory-role="unreserved"]').dataset.percent === '75', 'CPU unreserved ring is incorrect');
    assert(cpuGauge.querySelector('[data-memory-role="free"]').dataset.percent === '62.5', 'CPU actually-free ring is incorrect');
    assert(cpuGauge.textContent.includes('12 GiB unreserved'), 'CPU unreserved value is missing');
    assert(cpuGauge.textContent.includes('16 GiB total'), 'CPU total value is missing');
    assert(cpuGauge.getAttribute('aria-label').includes('10 GiB actually free'), 'CPU accessible free-memory value is missing');
    const installedModelCard = Array.from(document.querySelectorAll('#model-list .module-card')).find((card) => card.textContent.includes('installed-awq'));
    assert(installedModelCard, 'installed quantized model is missing');
    assert(installedModelCard.textContent.includes('Artifact: awq-int4'), 'installed model artifact is missing');
    assert(installedModelCard.textContent.includes('Format: safetensors'), 'installed model format is missing');
    assert(installedModelCard.textContent.includes('Precision: INT4'), 'installed model precision is missing');
    assert(installedModelCard.textContent.includes('Quantization: AWQ / 4-bit'), 'installed model quantization is missing');
    const modelCreateToggle = document.getElementById('model-create-toggle');
    const modelCreateFlow = document.getElementById('model-create-flow');
    assert(modelCreateToggle && modelCreateToggle.closest('.model-list-heading'), 'Create button is not beside Installed Models');
    assert(modelCreateFlow.hidden, 'model creation form must start collapsed');
    assert(!document.querySelector('.model-create-summary'), 'legacy Create Model summary is still visible');
    modelCreateToggle.click();
    await waitFor(() => !modelCreateFlow.hidden, 'open model creation form');
    assert(modelCreateToggle.getAttribute('aria-expanded') === 'true', 'Create button expansion state is incorrect');
    const sourceSelect = document.getElementById('model-source-select');
    const engineSelect = document.getElementById('local-model-engine');
    const computeSelect = document.getElementById('local-model-compute-target');
    const localModelSource = document.getElementById('local-model-source');
    const artifactSelect = document.getElementById('local-model-artifact');
    const huggingFaceQuery = document.getElementById('huggingface-model-query');
    const huggingFaceResults = document.getElementById('huggingface-model-results');
    const huggingFaceArtifacts = document.getElementById('huggingface-model-artifacts');
    const changeSelect = (select, value) => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await waitFor(() => sourceSelect.value === '', 'model source dropdown');
    assert(document.getElementById('model-engine-field').hidden, 'engine dropdown is visible before choosing Local');
    assert(document.getElementById('model-compute-field').hidden, 'hardware dropdown is visible before choosing an engine');
    assert(document.getElementById('local-model-form').hidden, 'local form is visible before source selection');
    assert(document.getElementById('external-model-form').hidden, 'external form is visible before source selection');

    changeSelect(sourceSelect, 'local');
    await waitFor(() => !document.getElementById('model-engine-field').hidden, 'inference engine dropdown');
    assert(sourceSelect.value === 'local', 'Local source selection disappeared');
    const engineChoices = Array.from(engineSelect.options).map((option) => option.value).filter(Boolean);
    assert(engineChoices.join(',') === 'VLLM,OLlama', 'available inference engines are incorrect');
    changeSelect(engineSelect, 'VLLM');
    await waitFor(() => !document.getElementById('model-compute-field').hidden, 'hardware dropdown');
    assert(sourceSelect.value === 'local', 'source dropdown disappeared after choosing an engine');
    assert(engineSelect.value === 'VLLM', 'engine selection disappeared');
    const computeChoices = Array.from(computeSelect.options).map((option) => option.value).filter(Boolean);
    assert(computeChoices.join(',') === 'cpu,nvidia-gpu', 'hardware dropdown must contain only available targets');
    assert(!computeChoices.includes('amd-gpu'), 'unavailable AMD target is visible');
    assert(!computeChoices.includes('intel-gpu'), 'unavailable Intel target is visible');

    changeSelect(computeSelect, 'nvidia-gpu');
    await waitFor(() => !document.getElementById('local-model-form').hidden, 'local model configuration');
    assert(!document.getElementById('model-engine-field').hidden, 'engine dropdown disappeared after choosing hardware');
    assert(!document.getElementById('model-compute-field').hidden, 'hardware dropdown disappeared after its selection');
    assert(engineSelect.value === 'VLLM', 'selected vLLM engine was not stored');
    assert(computeSelect.value === 'nvidia-gpu', 'selected NVIDIA target was not stored');
    assert(localModelSource.value === 'huggingface', 'Hugging Face search is not the default vLLM source');
    assert(Array.from(localModelSource.options).map((option) => option.value).join(',') === 'huggingface,preset,direct', 'vLLM model sources are incorrect');
    assert(!document.getElementById('huggingface-model-discovery').hidden, 'Hugging Face discovery is hidden');
    assert(document.getElementById('local-model-preset-fields').hidden, 'preset fields are visible during Hugging Face search');
    assert(document.getElementById('local-model-url').readOnly, 'discovered Hugging Face URL must be read only');
    assert(document.getElementById('local-model-form').elements.maxNumSeqs.value === '1', 'new models must start with one sequence');
    await waitFor(() => callExists('GET', '/api/model-discovery/popular'), 'Hugging Face trending models');
    await waitFor(() => document.querySelectorAll('#huggingface-popular-models [data-huggingface-query]').length === 2, 'dynamic Hugging Face trending buttons');
    assert(document.getElementById('huggingface-popular-models').textContent.includes('GLM-5.3'), 'trending model metadata is missing');
    assert(document.getElementById('huggingface-popular-models').textContent.includes('Qwen3.8-27B'), 'second trending model is missing');
    const matchingModelField = huggingFaceResults.closest('.model-discovery-field').getBoundingClientRect();
    const quantizationField = huggingFaceArtifacts.closest('.model-discovery-field').getBoundingClientRect();
    assert(quantizationField.top >= matchingModelField.bottom, 'model and quantization dropdowns are not stacked vertically');

    huggingFaceQuery.value = 'Qwen 3.6';
    document.getElementById('huggingface-model-search').click();
    await waitFor(() => callExists('GET', '/api/model-discovery/search'), 'Hugging Face model search');
    await waitFor(() => !huggingFaceResults.disabled && huggingFaceResults.options.length === 3, 'compatible Hugging Face results');
    const searchCall = window.__dashboardBrowserCalls.find((call) => call.path.startsWith('/api/model-discovery/search?'));
    assert(searchCall.path.includes('provider=huggingface'), 'Hugging Face provider is missing from search');
    assert(searchCall.path.includes('engine=VLLM'), 'selected engine is missing from search');
    assert(searchCall.path.includes('computeTarget=nvidia-gpu'), 'selected hardware is missing from search');
    assert(searchCall.path.includes('modelType=chat'), 'selected model type is missing from search');
    assert(!Array.from(huggingFaceResults.options).some((option) => option.value.includes('GGUF')), 'incompatible search result is visible');
    assert(huggingFaceResults.options[1].textContent.includes('safetensors'), 'result format metadata is missing');
    assert(huggingFaceResults.options[1].textContent.includes('Official'), 'result trust metadata is missing');
    assert(huggingFaceResults.options[1].textContent.includes('Compatible'), 'result compatibility metadata is missing');

    changeSelect(huggingFaceResults, 'Qwen/Qwen3.6-27B');
    await waitFor(() => callExists('GET', '/api/model-discovery/artifacts'), 'Hugging Face quantization lookup');
    await waitFor(() => !huggingFaceArtifacts.disabled && huggingFaceArtifacts.options.length === 2, 'Hugging Face artifact options');
    const artifactCall = window.__dashboardBrowserCalls.find((call) => call.path.startsWith('/api/model-discovery/artifacts?'));
    assert(artifactCall.path.includes('modelType=chat'), 'selected model type is missing from quantization lookup');
    assert(huggingFaceArtifacts.value === 'Qwen/Qwen3.6-27B', 'original Hugging Face artifact is not selected');
    assert(document.getElementById('local-model-url').value === 'hf://Qwen/Qwen3.6-27B', 'selected Hugging Face URL was not applied');
    assert(document.getElementById('huggingface-model-metadata').textContent.includes('Trust: Official'), 'selected model trust is missing');
    assert(document.getElementById('huggingface-model-metadata').textContent.includes('Format: safetensors'), 'selected model format is missing');
    await waitFor(() => memoryEstimateCallExists('VLLM', 'nvidia-gpu'), 'vLLM NVIDIA memory estimate request');
    await waitFor(() => document.getElementById('local-model-form').elements.contextWindow.value === '262144', 'model context from Hugging Face config');
    await waitFor(() => document.getElementById('huggingface-model-metadata').textContent.includes('Download: 14 GiB'), 'Hugging Face download size');
    assert(document.getElementById('huggingface-model-metadata').textContent.includes('Model context: 262,144 tokens'), 'Hugging Face context metadata is missing');
    document.getElementById('local-model-form').elements.name.value = 'my-custom-name';
    document.getElementById('local-model-form').elements.contextWindow.value = '12345';
    document.getElementById('local-model-form').elements.contextWindow.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('local-model-form').elements.maxNumSeqs.value = '3';
    changeSelect(huggingFaceArtifacts, 'community/Qwen3.6-27B-AWQ');
    await waitFor(() => document.getElementById('local-model-url').value === 'hf://community/Qwen3.6-27B-AWQ', 'changed Hugging Face artifact URL');
    assert(document.getElementById('local-model-form').elements.name.value === 'my-custom-name', 'artifact change reset the model name');
    assert(document.getElementById('local-model-form').elements.contextWindow.value === '12345', 'artifact change reset context size');
    assert(document.getElementById('local-model-form').elements.maxNumSeqs.value === '3', 'artifact change reset max sequences');
    assert(document.getElementById('huggingface-model-metadata').textContent.includes('Quantization: AWQ / 4-bit'), 'selected quantization metadata is missing');
    assert(document.getElementById('huggingface-model-metadata').textContent.includes('Trust: Community'), 'community trust metadata is missing');
    const modelLoadMore = document.getElementById('huggingface-model-load-more');
    const artifactLoadMore = document.getElementById('huggingface-artifact-load-more');
    assert(!modelLoadMore.hidden && !modelLoadMore.disabled, 'model pagination action is unavailable despite nextCursor');
    assert(!artifactLoadMore.hidden && !artifactLoadMore.disabled, 'artifact pagination action is unavailable despite nextCursor');
    artifactLoadMore.click();
    await waitFor(
      () => window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/model-discovery/artifacts?')).length === 2,
      'second Hugging Face artifact page'
    );
    await waitFor(() => huggingFaceArtifacts.options.length === 3, 'deduplicated appended quantizations');
    assert(huggingFaceArtifacts.value === 'community/Qwen3.6-27B-AWQ', 'quantization selection was lost while loading more');
    assert(Array.from(huggingFaceArtifacts.options).some((option) => option.value === 'community/Qwen3.6-27B-GPTQ'), 'new quantization was not appended');
    assert(artifactLoadMore.hidden, 'artifact pagination action stayed visible after the final page');
    assert(document.getElementById('huggingface-model-status').textContent.includes('3 artifact candidates loaded from 3 discovered'), 'artifact progress is incorrect');
    modelLoadMore.click();
    await waitFor(
      () => window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/model-discovery/search?')).length === 2,
      'second Hugging Face model page'
    );
    await waitFor(() => huggingFaceResults.options.length === 4, 'deduplicated appended model results');
    assert(huggingFaceResults.value === 'Qwen/Qwen3.6-27B', 'model selection was lost while loading more');
    assert(huggingFaceArtifacts.value === 'community/Qwen3.6-27B-AWQ', 'artifact selection was lost while loading more models');
    assert(Array.from(huggingFaceResults.options).some((option) => option.value === 'Qwen/Qwen3.6-35B-A3B'), 'new model was not appended');
    assert(modelLoadMore.hidden, 'model pagination action stayed visible after the final page');
    assert(document.getElementById('huggingface-model-status').textContent.includes('3 model candidates loaded from 4 discovered'), 'model progress is incorrect');
    changeSelect(document.getElementById('local-model-form').elements.modelType, 'embedding');
    await waitFor(
      () => window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/model-discovery/search?')).length === 3,
      'Hugging Face compatibility refresh after model type change'
    );
    const refreshedSearchCall = window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/model-discovery/search?')).at(-1);
    assert(refreshedSearchCall.path.includes('modelType=embedding'), 'changed model type is missing from refreshed search');
    await waitFor(
      () => window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/model-discovery/artifacts?')).length === 3,
      'quantization revalidation after model type change'
    );
    const refreshedArtifactCall = window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/model-discovery/artifacts?')).at(-1);
    assert(refreshedArtifactCall.path.includes('modelType=embedding'), 'changed model type is missing from refreshed quantization lookup');
    assert(sourceSelect.value === 'local', 'top-level source disappeared after model type change');
    assert(engineSelect.value === 'VLLM', 'engine selection disappeared after model type change');
    assert(computeSelect.value === 'nvidia-gpu', 'hardware selection disappeared after model type change');
    assert(localModelSource.value === 'huggingface', 'model source disappeared after model type change');
    assert(huggingFaceQuery.value === 'Qwen 3.6', 'Hugging Face query disappeared after model type change');
    assert(huggingFaceResults.value === 'Qwen/Qwen3.6-27B', 'model selection disappeared after compatible model type change');
    assert(huggingFaceArtifacts.value === 'community/Qwen3.6-27B-AWQ', 'quantization selection disappeared after compatible model type change');
    await waitFor(() => window.__dashboardBrowserCalls.some((call) => (
      call.method === 'POST'
      && call.path.split('?')[0] === '/api/models/estimate-memory'
      && call.body.artifact === null
      && call.body.url === 'hf://community/Qwen3.6-27B-AWQ'
    )), 'memory estimate for changed artifact');
    await waitFor(() => document.getElementById('vram-estimate-slider').max === '16300', 'VRAM capacity slider');
    assert(document.getElementById('vram-estimate-maximum').textContent === '15.9 GiB', '100% does not use the safe 100 MiB-rounded GPU capacity');
    assert(document.getElementById('vram-available-marker').textContent.includes('100% unreserved'), 'unreserved maximum marker is missing');
    assert(document.getElementById('vram-capacity-note').textContent.includes('unreserved VRAM'), 'unreserved maximum explanation is missing');
    assert(!document.getElementById('vram-capacity-overflow').hidden, 'capacity overflow area is hidden');
    assert(document.getElementById('vram-minimum-marker').classList.contains('overflow'), 'minimum marker is not in the overflow area');
    assert(document.getElementById('vram-recommended-marker').classList.contains('overflow'), 'recommended marker is not in the overflow area');
    assert(document.getElementById('vram-estimate-selected').textContent.includes('15.9 GiB'), 'slider did not clamp the allocation to available VRAM');
    assert(document.querySelector('.vram-breakdown-details'), 'VRAM breakdown was removed');
    assert(document.getElementById('ram-reservation').hidden, 'CPU RAM reservation is visible for GPU inference');

    changeSelect(localModelSource, 'preset');
    assert(!document.getElementById('local-model-preset-fields').hidden, 'tested preset fallback is hidden');
    assert(document.getElementById('huggingface-model-discovery').hidden, 'Hugging Face results remained visible for preset source');
    assert(document.getElementById('local-model-preset').value === 'qwen3635b', 'NVIDIA preset fallback is incorrect');
    assert(artifactSelect.value === 'awq-int4', 'preset artifact fallback is incorrect');
    assert(document.getElementById('local-model-url').value === 'hf://example/qwen-gpu-awq', 'preset artifact URL was not applied');
    changeSelect(localModelSource, 'huggingface');
    assert(huggingFaceResults.value === 'Qwen/Qwen3.6-27B', 'Hugging Face result selection disappeared after source switch');
    assert(huggingFaceArtifacts.value === 'community/Qwen3.6-27B-AWQ', 'quantization selection disappeared after source switch');
    assert(document.getElementById('local-model-url').value === 'hf://community/Qwen3.6-27B-AWQ', 'selected quantization URL was not restored');

    changeSelect(computeSelect, 'cpu');
    await waitFor(() => memoryEstimateCallExists('VLLM', 'cpu'), 'vLLM CPU memory estimate request');
    await waitFor(() => document.getElementById('ram-estimate-recommended').textContent === '4.0 GiB', 'vLLM CPU recommended RAM');
    assert(!document.getElementById('local-model-form').hidden, 'CPU local model form did not stay open');
    assert(localModelSource.value === 'huggingface', 'Hugging Face source disappeared after hardware switch');
    assert(huggingFaceQuery.value === 'Qwen 3.6', 'Hugging Face query disappeared after hardware switch');
    assert(!document.getElementById('cpu-runtime-summary').hidden, 'CPU runtime summary is hidden');
    assert(document.getElementById('vram-estimate').hidden, 'VRAM controls are visible for CPU inference');
    assert(!document.getElementById('ram-reservation').hidden, 'CPU RAM reservation is hidden');
    assert(document.getElementById('ram-reservation-slider').max === '12200', 'CPU reservation maximum is not the safe 100 MiB-rounded unreserved RAM');
    assert(document.getElementById('ram-estimate-minimum').textContent === '3.0 GiB', 'vLLM CPU minimum RAM is missing');
    assert(document.getElementById('ram-reservation-selected').textContent.includes('4.0 GiB'), 'vLLM CPU recommended reservation is incorrect');
    assert(document.getElementById('local-model-form').elements.contextWindow.max === '262144', 'model context maximum was not applied to the form');
    assert(document.getElementById('ram-available-marker').textContent.includes('100% unreserved'), 'CPU unreserved marker is missing');
    assert(document.getElementById('ram-capacity-note').textContent.includes('unreserved RAM'), 'CPU unreserved explanation is missing');
    assert(document.querySelector('#ram-reservation .vram-breakdown-details'), 'CPU memory breakdown is missing');
    const ramSlider = document.getElementById('ram-reservation-slider');
    ramSlider.value = '6200';
    ramSlider.dispatchEvent(new Event('input', { bubbles: true }));
    assert(document.getElementById('local-model-form').elements.memoryRequiredMi.value === '6200', 'CPU RAM reservation slider did not keep its 100 MiB planning step');

    changeSelect(localModelSource, 'preset');
    assert(document.getElementById('local-model-preset').value === 'qwen2505bcpu', 'CPU preset fallback is incorrect');
    assert(artifactSelect.value === 'int8', 'CPU preset quantization is incorrect');
    changeSelect(localModelSource, 'huggingface');

    changeSelect(engineSelect, 'OLlama');
    await waitFor(() => engineSelect.value === 'OLlama' && computeSelect.value === 'cpu', 'persistent Ollama and CPU selection');
    const ollamaTargets = Array.from(computeSelect.options).map((option) => option.value).filter(Boolean);
    assert(!ollamaTargets.includes('intel-gpu'), 'unsupported Ollama Intel target is visible');
    assert(Array.from(localModelSource.options).map((option) => option.value).join(',') === 'preset,direct', 'Ollama sources must not include Hugging Face search');
    assert(localModelSource.value === 'preset', 'Ollama did not fall back to a tested preset');
    assert(document.getElementById('huggingface-model-discovery').hidden, 'Hugging Face search is visible for Ollama');
    await waitFor(() => document.getElementById('local-model-url').value === 'ollama://qwen2.5:0.5b', 'Ollama preset fields');
    assert(artifactSelect.value === 'q4-k-m', 'default Ollama artifact was not selected');
    assert(document.getElementById('local-model-url-label').textContent === 'Ollama Model URL', 'Ollama URL label is missing');
    assert(engineSelect.value === 'OLlama', 'selected Ollama engine was not stored');
    assert(!document.getElementById('ram-reservation').hidden, 'Ollama CPU RAM reservation is hidden');
    await waitFor(() => memoryEstimateCallExists('OLlama', 'cpu'), 'Ollama CPU memory estimate request');
    await waitFor(() => document.getElementById('ram-estimate-recommended').textContent === '1.7 GiB', 'Ollama CPU recommended RAM');
    assert(document.getElementById('ram-estimate-minimum').textContent === '1.2 GiB', 'Ollama CPU minimum RAM is missing');
    assert(document.getElementById('ram-reservation-selected').textContent.includes('1.7 GiB'), 'Ollama CPU recommended reservation is incorrect');

    changeSelect(sourceSelect, 'external');
    await waitFor(() => !document.getElementById('external-model-form').hidden, 'external model form');
    assert(document.getElementById('local-model-form').hidden, 'local and external forms are visible together');
    assert(sourceSelect.value === 'external', 'External source selection disappeared');
    changeSelect(sourceSelect, 'local');
    await waitFor(() => !document.getElementById('local-model-form').hidden, 'return to persistent local configuration');
    assert(engineSelect.value === 'OLlama', 'engine selection was lost after switching source');
    assert(computeSelect.value === 'cpu', 'hardware selection was lost after switching source');
    assert(localModelSource.value === 'preset', 'Ollama model source was lost after switching location');
    changeSelect(localModelSource, 'direct');
    assert(document.getElementById('local-model-preset-fields').hidden, 'preset fields are visible for a direct model URL');
    const localUrl = document.getElementById('local-model-url');
    assert(!localUrl.readOnly, 'direct Ollama model reference is read only');
    localUrl.value = 'ollama://qwen3:8b';
    localUrl.dispatchEvent(new Event('input', { bubbles: true }));
    ramSlider.value = '4096';
    ramSlider.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('local-model-form').requestSubmit();
    await waitFor(() => callExists('POST', '/api/models/local'), 'local model creation');
    const localModelCall = window.__dashboardBrowserCalls.find((call) => call.method === 'POST' && call.path === '/api/models/local');
    assert(localModelCall.body.local.memoryRequiredMi === 4100, 'Ollama CPU memory reservation was not submitted in 100 MiB increments');
    assert(localModelCall.body.local.url === 'ollama://qwen3:8b', 'direct Ollama model reference was not submitted');
    assert(!Object.prototype.hasOwnProperty.call(localModelCall.body.local, 'artifact'), 'stale preset artifact was submitted for direct source');
    await waitFor(() => modelCreateFlow.hidden, 'close model creation form after submit');
    assert(modelCreateToggle.getAttribute('aria-expanded') === 'false', 'Create button expansion state stayed open after submit');
    assert(modelCreateToggle.textContent === 'Create', 'Create button label was not restored after submit');

    document.querySelector('[data-tab="settings"]').click();
    await waitFor(() => !document.getElementById('tab-settings').hidden, 'Settings tab');
    const settingsForm = document.getElementById('settings-form');
    const settingsFields = Array.from(settingsForm.querySelectorAll('input')).map((input) => input.name);
    assert(settingsFields.join(',') === 'publicDomain,mdnsDomain', 'Settings must contain only public and mDNS domains');
    assert(!settingsForm.elements.namedItem('dashboardHost'), 'redundant dashboard host field is still present');
    assert(!document.getElementById('settings-dashboard-public'), 'redundant Addresses card is still present');
    settingsForm.elements.publicDomain.value = 'new.example.com';
    settingsForm.elements.mdnsDomain.value = 'new.local';
    settingsForm.requestSubmit();
    await waitFor(() => callExists('PATCH', '/api/settings'), 'settings update');
    const settingsPatch = window.__dashboardBrowserCalls.find((call) => call.method === 'PATCH' && call.path === '/api/settings');
    assert(settingsPatch.body.publicDomain === 'new.example.com', 'public domain was not submitted');
    assert(settingsPatch.body.mdnsDomain === 'new.local', 'mDNS domain was not submitted');
    assert(!Object.prototype.hasOwnProperty.call(settingsPatch.body, 'dashboardHost'), 'dashboard host must not be submitted separately');

    document.querySelector('[data-tab="system"]').click();
    await waitFor(() => !document.getElementById('tab-system').hidden, 'System Status tab');
    await waitFor(() => document.querySelectorAll('[data-hardware-operator]').length === 3, 'hardware operator cards');
    assert(document.querySelector('[data-hardware-operator="nvidia"]').textContent.includes('Ready'), 'NVIDIA hardware-resource state is missing');
    assert(document.querySelector('[data-hardware-operator="amd"]').textContent.includes('Installing'), 'AMD installing state is missing');
    assert(document.querySelector('[data-hardware-operator="intel"]').textContent.includes('1 allocatable resource'), 'Intel resource readiness is missing');
    assert(document.getElementById('hardware-operator-summary').textContent === '2 ready / 3 active / 3 known', 'hardware operator summary is incorrect');

    const usersTab = document.getElementById('users-tab-button');
    assert(usersTab, 'Users tab is missing from the rendered DOM');
    const apiAccessTab = document.getElementById('api-access-tab-button');
    assert(apiAccessTab, 'API Access tab is missing from the rendered DOM');
    const kubernetesAccessTab = document.getElementById('kubernetes-access-tab-button');
    assert(kubernetesAccessTab, 'Kubernetes Access tab is missing from the rendered DOM');
    const canManageApiAccess = scenario === 'admin' || scenario === 'unavailable';
    assert(apiAccessTab.hidden === !canManageApiAccess, scenario + ' API Access visibility is incorrect');
    assert(kubernetesAccessTab.hidden === (scenario !== 'admin'), scenario + ' Kubernetes Access visibility is incorrect');

    if (scenario !== 'admin') {
      assert(usersTab.hidden, scenario + ' must not see the Users tab');
      assert(!window.__dashboardBrowserCalls.some((call) => call.path.startsWith('/api/users')), 'hidden tab must not load users');
      assert(!window.__dashboardBrowserCalls.some((call) => call.path.startsWith('/api/kubernetes-access')), 'hidden tab must not load Kubernetes access');
      result.dataset.status = 'passed';
      result.textContent = 'passed:' + scenario;
      return;
    }

    assert(!usersTab.hidden, 'administrator cannot see the Users tab');
    usersTab.click();
    await waitFor(() => callExists('GET', '/api/users'), 'lazy user list request');
    const createButton = document.getElementById('user-create');
    assert(createButton && !createButton.hidden && !createButton.closest('[hidden]'), 'Create User button is not visible');
    assert(window.getComputedStyle(createButton).display !== 'none', 'Create User button is not rendered');

    createButton.click();
    const editorDialog = document.getElementById('user-editor-dialog');
    await waitFor(() => editorDialog.open, 'Create User dialog');
    await sleep(20);
    assert(document.activeElement === editorDialog.querySelector('input[name="username"]'), 'Create User dialog did not receive focus');
    const editor = document.getElementById('user-editor-form');
    editor.elements.username.value = 'browser-user';
    editor.elements.firstName.value = 'Browser';
    editor.elements.lastName.value = 'User';
    editor.elements.email.value = 'browser.user@example.com';
    editor.elements.accessLevel.value = 'viewer';
    editor.elements.password.value = 'temporary-Password-123!';
    editor.elements.passwordConfirmation.value = 'temporary-Password-123!';
    editor.requestSubmit();
    await waitFor(() => callExists('POST', '/api/users') && !editorDialog.open, 'create request');
    await waitFor(() => document.querySelector('[data-user-action="edit"]'), 'created user row');

    (await actionButton('edit')).click();
    await waitFor(() => editorDialog.open && callExists('GET', '/api/users/u-1'), 'edit dialog');
    editor.elements.firstName.value = 'Updated';
    editor.requestSubmit();
    await waitFor(() => callExists('PATCH', '/api/users/u-1') && !editorDialog.open, 'profile update request');

    (await actionButton('roles')).click();
    const roleDialog = document.getElementById('user-role-dialog');
    await waitFor(() => roleDialog.open, 'role dialog');
    const roleForm = document.getElementById('user-role-form');
    roleForm.elements.accessLevel.value = 'operator';
    roleForm.requestSubmit();
    await waitFor(() => callExists('PUT', '/api/users/u-1/roles') && !roleDialog.open, 'role update request');

    (await actionButton('disable')).click();
    const confirmDialog = document.getElementById('user-confirm-dialog');
    await waitFor(() => confirmDialog.open, 'disable confirmation');
    document.getElementById('user-confirm-form').requestSubmit();
    await waitFor(() => callExists('POST', '/api/users/u-1/disable') && !confirmDialog.open, 'disable request');

    (await actionButton('enable')).click();
    await waitFor(() => confirmDialog.open, 'enable confirmation');
    document.getElementById('user-confirm-form').requestSubmit();
    await waitFor(() => callExists('POST', '/api/users/u-1/enable') && !confirmDialog.open, 'enable request');

    (await actionButton('password')).click();
    const passwordDialog = document.getElementById('user-password-dialog');
    await waitFor(() => passwordDialog.open, 'password dialog');
    const passwordForm = document.getElementById('user-password-form');
    passwordForm.elements.password.value = 'replacement-Password-123!';
    passwordForm.elements.passwordConfirmation.value = 'replacement-Password-123!';
    passwordForm.requestSubmit();
    await waitFor(() => callExists('PUT', '/api/users/u-1/password') && !passwordDialog.open, 'password reset request');

    (await actionButton('delete')).click();
    await waitFor(() => confirmDialog.open, 'delete confirmation');
    const confirmForm = document.getElementById('user-confirm-form');
    confirmForm.elements.usernameConfirmation.value = 'browser-user';
    confirmForm.requestSubmit();
    await waitFor(() => callExists('DELETE', '/api/users/u-1') && !confirmDialog.open, 'delete request');

    apiAccessTab.click();
    await waitFor(() => callExists('GET', '/api/api-access'), 'lazy API access list request');
    await waitFor(() => document.getElementById('api-access-list').textContent.includes('Existing integration'), 'initial API key row');
    assert(!document.getElementById('api-access-list').textContent.includes('sk-'), 'API key secret leaked into the list');
    assert(document.getElementById('api-access-endpoints').textContent.includes('https://litellm.magicstick.local/v1'), 'local API base is missing');

    document.getElementById('api-access-create').click();
    const apiCreateDialog = document.getElementById('api-access-create-dialog');
    await waitFor(() => apiCreateDialog.open, 'Create API key dialog');
    const apiCreateForm = document.getElementById('api-access-create-form');
    apiCreateForm.elements.name.value = 'CI pipeline';
    apiCreateForm.requestSubmit();
    const apiCreatedDialog = document.getElementById('api-access-created-dialog');
    await waitFor(() => callExists('POST', '/api/api-access') && apiCreatedDialog.open, 'API key creation');
    assert(document.getElementById('api-access-created-key').value === 'sk-BROWSER-ONE-TIME-CHANGEME', 'new API key was not shown once');
    await waitFor(() => document.getElementById('api-access-list').textContent.includes('CI pipeline'), 'created API key row');
    const doneButton = apiCreatedDialog.querySelector('[data-dialog-cancel]');
    doneButton.click();
    await waitFor(() => !apiCreatedDialog.open, 'close created API key dialog');
    assert(document.getElementById('api-access-created-key').value === '', 'one-time API key was not cleared after closing');

    const createdApiRow = Array.from(document.querySelectorAll('#api-access-list tr'))
      .find((row) => row.textContent.includes('CI pipeline'));
    assert(createdApiRow, 'created API key row is missing');
    createdApiRow.querySelector('[data-api-access-action="revoke"]').click();
    const revokeDialog = document.getElementById('api-access-revoke-dialog');
    await waitFor(() => revokeDialog.open, 'API key revoke confirmation');
    document.getElementById('api-access-revoke-form').requestSubmit();
    await waitFor(
      () => window.__dashboardBrowserCalls.some((call) => call.method === 'DELETE' && call.path.startsWith('/api/api-access/')) && !revokeDialog.open,
      'API key revocation'
    );

    const expectedCalls = [
      ['POST', '/api/users'],
      ['GET', '/api/users/u-1'],
      ['PATCH', '/api/users/u-1'],
      ['PUT', '/api/users/u-1/roles'],
      ['POST', '/api/users/u-1/disable'],
      ['POST', '/api/users/u-1/enable'],
      ['PUT', '/api/users/u-1/password'],
      ['DELETE', '/api/users/u-1']
    ];
    expectedCalls.forEach(([method, path]) => assert(callExists(method, path), 'missing ' + method + ' ' + path));
    const mutations = window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/users') && !['GET', 'HEAD'].includes(call.method));
    assert(mutations.every((call) => call.headers['X-MagicStick-CSRF'] === 'dashboard'), 'a user mutation omitted the CSRF header');
    assert(mutations.every((call) => call.headers['Content-Type'] === 'application/json'), 'a user mutation omitted JSON content type');
    const roleUpdate = mutations.find((call) => call.method === 'PUT' && call.path === '/api/users/u-1/roles');
    assert(roleUpdate && roleUpdate.body.accessLevel === 'operator', 'role update did not preserve the selected access level');
    const deletion = mutations.find((call) => call.method === 'DELETE');
    assert(deletion && deletion.body.usernameConfirmation === 'browser-user', 'delete confirmation body is missing');
    const apiMutations = window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/api-access') && !['GET', 'HEAD'].includes(call.method));
    assert(apiMutations.length === 2, 'API access create/revoke calls are incomplete');
    assert(apiMutations.every((call) => call.headers['X-MagicStick-CSRF'] === 'dashboard'), 'an API access mutation omitted the CSRF header');
    assert(apiMutations.find((call) => call.method === 'POST').body.name === 'CI pipeline', 'API access name was not submitted');

    kubernetesAccessTab.click();
    await waitFor(() => callExists('GET', '/api/kubernetes-access'), 'lazy Kubernetes access list request');
    await waitFor(() => document.getElementById('kubernetes-access-list').textContent.includes('cluster-user'), 'Kubernetes user row');
    assert(document.getElementById('kubernetes-access-configuration').textContent.includes('contains no token'), 'token-free kubeconfig explanation is missing');
    const kubeRow = document.querySelector('#kubernetes-access-list tr');
    const editKubernetesAccess = kubeRow.querySelector('[data-kubernetes-access-action="edit"]');
    editKubernetesAccess.click();
    const kubernetesDialog = document.getElementById('kubernetes-access-dialog');
    await waitFor(() => kubernetesDialog.open, 'Kubernetes access dialog');
    const kubernetesForm = document.getElementById('kubernetes-access-form');
    kubernetesForm.elements.accessLevel.value = 'operator';
    kubernetesForm.elements.accessLevel.dispatchEvent(new Event('change', { bubbles: true }));
    assert(document.getElementById('kubernetes-access-level-note').textContent.includes('cannot create arbitrary workloads'), 'operator boundary is missing');
    kubernetesForm.requestSubmit();
    await waitFor(() => callExists('PUT', '/api/kubernetes-access/kube-user-1') && !kubernetesDialog.open, 'Kubernetes access update');
    await waitFor(() => document.getElementById('kubernetes-access-list').textContent.includes('Operator'), 'updated Kubernetes access');
    document.querySelector('[data-kubernetes-access-action="download"]').click();
    await waitFor(() => callExists('GET', '/api/kubernetes-access/kube-user-1/kubeconfig'), 'Kubernetes kubeconfig download');
    const kubeconfigCallsBeforeCopy = window.__dashboardBrowserCalls.filter(
      (call) => call.method === 'GET' && call.path.split('?')[0] === '/api/kubernetes-access/kube-user-1/kubeconfig'
    ).length;
    const copyKubernetesAccess = document.querySelector('[data-kubernetes-access-action="copy"]');
    assert(copyKubernetesAccess && copyKubernetesAccess.textContent === 'Copy to Clipboard', 'Kubernetes kubeconfig copy action is missing');
    copyKubernetesAccess.click();
    await waitFor(
      () => window.__dashboardBrowserCalls.filter(
        (call) => call.method === 'GET' && call.path.split('?')[0] === '/api/kubernetes-access/kube-user-1/kubeconfig'
      ).length > kubeconfigCallsBeforeCopy,
      'Kubernetes kubeconfig copy request'
    );
    await waitFor(() => window.__dashboardClipboardWrites.length === 1, 'Kubernetes kubeconfig clipboard write');
    assert(window.__dashboardClipboardWrites[0].includes('apiVersion: v1'), 'clipboard did not receive the kubeconfig');
    assert(document.getElementById('kubernetes-access-output').textContent.includes('Kubeconfig copied'), 'Kubernetes kubeconfig copy confirmation is missing');
    const kubernetesMutations = window.__dashboardBrowserCalls.filter((call) => call.path.startsWith('/api/kubernetes-access') && !['GET', 'HEAD'].includes(call.method));
    assert(kubernetesMutations.length === 1, 'Kubernetes access mutation is missing');
    assert(kubernetesMutations[0].body.accessLevel === 'operator', 'Kubernetes access level was not submitted');
    assert(kubernetesMutations[0].headers['X-MagicStick-CSRF'] === 'dashboard', 'Kubernetes access mutation omitted the CSRF header');

    result.dataset.status = 'passed';
    result.textContent = 'passed:' + scenario;
  })().catch((error) => {
    result.dataset.status = 'failed';
    result.textContent = 'failed:' + scenario + ':' + (error && error.message ? error.message : String(error));
  });
})();
"""


def instrumented_dashboard_html(source):
    html = rendered_dashboard_html(source).replace("setInterval(refresh, 30000);", "")
    html = html.replace(
        "const refresh = async () => {",
        "const refresh = window.__dashboardRefresh = async () => {",
        1,
    )
    html = html.replace(
        "<script>",
        "<script>\n" + BROWSER_API_MOCK + "\n</script>\n<script>",
        1,
    )
    return html.replace(
        "</body>",
        "<script>\n" + BROWSER_ASSERTIONS + "\n</script>\n</body>",
        1,
    )


class DashboardUserManagementUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = dashboard_source()
        cls.script = embedded_script(cls.source)

    def test_embedded_javascript_is_valid(self):
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        result = subprocess.run(
            ["node", "--check"],
            input=self.script,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_users_tab_is_admin_gated_and_create_button_is_visible(self):
        self.assertIn('id="users-tab-button"', self.source)
        self.assertIn('id="users-tab-button" type="button" aria-selected="false" data-tab="users" hidden', self.source)
        self.assertIn('id="user-create" type="button">Create User</button>', self.source)
        self.assertIn("roles.includes('magicstick-admin')", self.script)
        self.assertIn("identityManagementAvailable !== false", self.script)

    def test_api_access_tab_is_admin_gated_and_uses_one_time_keys(self):
        self.assertIn('id="api-access-tab-button"', self.source)
        self.assertIn('id="api-access-tab-button" type="button" aria-selected="false" data-tab="api-access" hidden', self.source)
        self.assertIn('id="api-access-create" type="button">Create API Key</button>', self.source)
        self.assertIn('id="api-access-created-key" type="text" readonly', self.source)
        self.assertIn("const sessionCanManageApiAccess", self.script)
        self.assertIn("await dashboardRequest('/api/api-access')", self.script)
        self.assertIn("method: 'POST'", self.script)
        self.assertIn("method: 'DELETE'", self.script)
        self.assertIn("keyInput.value = '';", self.script)
        api_code = self.script.split("const sessionCanManageApiAccess", 1)[1].split("const renderStatus", 1)[0]
        self.assertNotIn("innerHTML", api_code)
        self.assertIn("textContent", api_code)

    def test_kubernetes_access_tab_is_admin_gated_and_uses_oidc_kubeconfigs(self):
        self.assertIn('id="kubernetes-access-tab-button"', self.source)
        self.assertIn(
            'id="kubernetes-access-tab-button" type="button" aria-selected="false" data-tab="kubernetes-access" hidden',
            self.source,
        )
        self.assertIn("const sessionCanManageKubernetesAccess", self.script)
        self.assertIn("await dashboardRequest('/api/kubernetes-access?'", self.script)
        self.assertIn("'/kubeconfig'", self.script)
        self.assertIn("copy.textContent = 'Copy to Clipboard'", self.script)
        self.assertIn("const copyKubernetesKubeconfig", self.script)
        self.assertIn("await copyText(content)", self.script)
        self.assertIn("method: 'PUT'", self.script)
        kubernetes_code = self.script.split("const kubernetesAccessLabel", 1)[1].split("const renderStatus", 1)[0]
        self.assertNotIn("innerHTML", kubernetes_code)
        self.assertIn("textContent", kubernetes_code)
        self.assertIn("contains no token", kubernetes_code)

    def test_overview_shows_full_module_and_instance_urls_from_http_routes(self):
        self.assertIn("<h3>Available URLs</h3>", self.source)
        self.assertIn("const linksFromHttpRoute", self.script)
        self.assertIn("(status || {}).httpRoutes", self.script)
        self.assertIn("anchor.textContent = link.url", self.script)
        self.assertIn("seenLinks.size === 1 ? ' URL' : ' URLs'", self.script)
        self.assertIn("No module or instance URLs discovered yet.", self.script)

    def test_litellm_credentials_are_catalog_driven_and_role_gated(self):
        self.assertIn("credentialSpec = (catalogSpec || {}).credentials", self.script)
        self.assertIn("credentials.dataset.moduleCredentials = name", self.script)
        self.assertIn("/api/modules/", self.script)
        self.assertIn("sessionCanReadCredentials(latestSession)", self.script)
        self.assertIn("roles.includes('magicstick-operator')", self.script)
        self.assertIn("roles.includes('magicstick-admin')", self.script)
        self.assertIn("showCredentials(card, payload)", self.script)

    def test_services_tab_combines_modules_and_instances(self):
        self.assertIn('data-tab="services"', self.source)
        self.assertIn('id="tab-services"', self.source)
        self.assertNotIn('data-tab="modules"', self.source)
        self.assertNotIn('data-tab="instances"', self.source)
        self.assertIn('id="service-applications-list"', self.source)
        self.assertIn('id="service-runtime-list"', self.source)
        self.assertIn('id="service-platform-list"', self.source)
        self.assertIn('id="service-platform-toggle"', self.source)
        self.assertIn("const expandedApplicationInstances = new Set();", self.script)
        self.assertIn("instanceToggle.dataset.serviceInstancesToggle = type", self.script)
        self.assertIn("instanceList.dataset.serviceInstancesList = type", self.script)
        self.assertIn("instanceList.hidden = !expanded", self.script)
        self.assertIn("metaRow.appendChild(instanceToggle)", self.script)
        self.assertNotIn("configured instance", self.script.split("const createApplicationServiceCard =", 1)[1].split("const appendServiceEmpty =", 1)[0])
        self.assertIn("const renderServices = (modulePayload, instancePayload, statusPayload = {}, modelPayload = {}) =>", self.script)
        self.assertIn("const serviceHardwareOperatorState = (name, statusPayload = {}, modelPayload = {}) =>", self.script)
        self.assertIn("waiting for DCGM telemetry before reporting the service ready", self.script)
        self.assertIn("applicationList.appendChild(createApplicationServiceCard", self.script)
        self.assertIn("instanceList.appendChild(createInstanceServiceCard", self.script)
        self.assertIn("renderServices(modulePayload, instancePayload, status, modelPayload);", self.script)
        self.assertNotIn("renderModules(modulePayload, status);", self.script)
        self.assertNotIn("renderInstances(instancePayload, status);", self.script)
        service_cards = self.script.split("const createApplicationServiceCard =", 1)[1].split("const createModuleServiceRow =", 1)[0]
        self.assertNotIn("Enable and wait for:", service_cards)

    def test_instance_creation_uses_catalog_driven_two_step_dialog(self):
        self.assertIn('id="instance-create-open"', self.source)
        self.assertIn('id="instance-create-dialog"', self.source)
        self.assertIn('id="instance-type-picker"', self.source)
        self.assertIn('id="instance-config-step"', self.source)
        self.assertNotIn('id="instance-create-back"', self.source)
        self.assertNotIn('Back to types', self.source)
        self.assertNotIn('class="instance-create-summary"', self.source)
        self.assertIn("const renderInstanceTypeChoices = () =>", self.script)
        self.assertIn("applicationDefinitions(latestModulePayload)[type]", self.script)
        self.assertIn("button.dataset.instanceChoice = type", self.script)
        self.assertIn("form.hidden = form !== selectedForm", self.script)
        self.assertIn("selectInstanceCreateType('')", self.script)

    def test_settings_show_only_public_and_mdns_domains(self):
        self.assertIn('id="settings-form"', self.source)
        self.assertIn('name="publicDomain"', self.source)
        self.assertIn('name="mdnsDomain"', self.source)
        self.assertNotIn('Dashboard Public Host', self.source)
        self.assertNotIn('<h3>Addresses</h3>', self.source)
        self.assertNotIn('settings-dashboard-public', self.source)
        self.assertNotIn('settings-anythingllm-public', self.source)
        self.assertNotIn('dashboardHost', self.script)

    def test_local_model_creation_uses_persistent_dropdowns_and_available_targets(self):
        self.assertIn('id="model-create-toggle"', self.source)
        self.assertIn('class="model-list-heading"', self.source)
        self.assertIn('id="model-create-flow" hidden', self.source)
        self.assertNotIn('model-create-panel', self.source)
        self.assertNotIn('model-create-summary', self.source)
        self.assertIn('id="model-source-select"', self.source)
        self.assertIn('<option value="local">Local</option>', self.source)
        self.assertIn('<option value="external">External</option>', self.source)
        self.assertIn('id="model-engine-field"', self.source)
        self.assertIn('id="model-compute-field"', self.source)
        self.assertIn('id="local-model-compute-target"', self.source)
        self.assertIn('id="local-model-engine"', self.source)
        self.assertIn('id="local-model-artifact"', self.source)
        self.assertIn('Precision / Quantization', self.source)
        self.assertIn('id="local-model-source"', self.source)
        self.assertIn('<option value="huggingface">Hugging Face search</option>', self.source)
        self.assertIn('<option value="preset">Tested preset</option>', self.source)
        self.assertIn('<option value="direct">Direct model URL</option>', self.source)
        self.assertIn('id="huggingface-model-query"', self.source)
        self.assertIn('id="huggingface-popular-models"', self.source)
        self.assertIn('Trending on Hugging Face', self.source)
        self.assertNotIn('data-huggingface-query="Qwen"', self.source)
        self.assertIn('id="huggingface-model-results"', self.source)
        self.assertIn('id="huggingface-model-artifacts"', self.source)
        self.assertIn('id="huggingface-model-load-more"', self.source)
        self.assertIn('id="huggingface-artifact-load-more"', self.source)
        self.assertNotIn('id="huggingface-model-results" size=', self.source)
        self.assertNotIn('id="huggingface-model-artifacts" size=', self.source)
        self.assertNotIn('model-create-wizard', self.source)
        self.assertNotIn('model-create-step-label', self.source)
        self.assertNotIn('model-engine-back', self.source)
        self.assertNotIn('model-compute-back', self.source)
        self.assertNotIn('local-model-back', self.source)
        self.assertNotIn('external-model-back', self.source)
        self.assertIn("{ id: 'OLlama', label: 'Ollama'", self.script)
        self.assertIn('data-compute-target-section="gpu"', self.source)
        self.assertIn('data-compute-target-section="cpu"', self.source)
        self.assertIn('id="vram-capacity-overflow"', self.source)
        self.assertIn('id="vram-minimum-marker"', self.source)
        self.assertIn('id="vram-recommended-marker"', self.source)
        self.assertIn('class="vram-breakdown-details"', self.source)
        self.assertIn('id="ram-reservation-slider"', self.source)
        self.assertIn('id="ram-estimate-minimum"', self.source)
        self.assertIn('id="ram-estimate-recommended"', self.source)
        self.assertIn('id="ram-capacity-overflow"', self.source)
        self.assertIn('id="ram-minimum-marker"', self.source)
        self.assertIn('id="ram-recommended-marker"', self.source)
        self.assertIn('data-ram-use="minimum"', self.source)
        self.assertIn('name="memoryRequiredMi"', self.source)
        self.assertIn('100% unreserved', self.source)
        self.assertNotIn('100% available', self.source)
        self.assertIn('const targetUnreservedMemoryMi =', self.script)
        self.assertIn('payload.local.memoryRequiredMi = Number', self.script)
        self.assertIn('const rawMaximum = unreservedMaximum === null ? estimatedMaximum : unreservedMaximum;', self.script)
        self.assertIn('const MEMORY_RESERVATION_STEP_MI = 100;', self.script)
        self.assertIn("request('/api/models/estimate-memory'", self.script)
        self.assertIn('renderCpuMemoryEstimate', self.script)
        self.assertIn("const selectModelCreateSource = (source) =>", self.script)
        self.assertIn("const selectLocalEngine = (engine) =>", self.script)
        self.assertIn("const renderComputeTargets = (modelPayload) =>", self.script)
        self.assertIn("modelSourceSelect.addEventListener('change'", self.script)
        self.assertIn("localModelEngineSelect.addEventListener('change'", self.script)
        self.assertIn("localModelComputeSelect.addEventListener('change'", self.script)
        self.assertIn("modelCreateToggle.addEventListener('click'", self.script)
        self.assertIn("const closeModelCreateFlow = () =>", self.script)
        self.assertEqual(self.script.count("closeModelCreateFlow();"), 2)
        self.assertIn("if (localForm) { localForm.hidden = !local || !selectedComputeTarget(); }", self.script)
        self.assertIn(".filter((target) => target.available === true", self.script)
        self.assertIn("const presetVariant = (preset, targetId, engine = selectedLocalEngine()) =>", self.script)
        self.assertIn("const presetArtifacts = (variant) =>", self.script)
        self.assertIn("const resolvedPresetArtifact = (variant, artifactId = '') =>", self.script)
        self.assertIn("const renderLocalArtifactOptions = (variant, requestedArtifact = '') =>", self.script)
        self.assertIn("localArtifactSelect.addEventListener('change'", self.script)
        self.assertIn("request('/api/model-discovery/search?'", self.script)
        self.assertIn("request('/api/model-discovery/popular?'", self.script)
        self.assertIn("request('/api/model-discovery/artifacts?'", self.script)
        self.assertIn("const searchHuggingFaceModels = async (rawQuery, options = {}) =>", self.script)
        self.assertIn("const selectedLocalModelType = () =>", self.script)
        self.assertIn("modelType: selectedLocalModelType()", self.script)
        self.assertIn("const refreshHuggingFaceModelType = () =>", self.script)
        self.assertIn("const compatibleDiscoveryItems = (items) =>", self.script)
        self.assertIn("const mergeDiscoveryItems = (...collections) =>", self.script)
        self.assertIn("const updateDiscoveryLoadMore = (id, nextCursor, loading = false) =>", self.script)
        self.assertIn("options.append === true", self.script)
        self.assertIn("huggingFaceSearchNextCursor = (payload || {}).nextCursor", self.script)
        self.assertIn("huggingFaceArtifactNextCursor = (payload || {}).nextCursor", self.script)
        self.assertIn("{ append: true }", self.script)
        self.assertIn("const renderHuggingFaceMetadata = (item) =>", self.script)
        self.assertIn("const syncHuggingFaceEstimateMetadata = (estimate) =>", self.script)
        self.assertIn("const loadHuggingFacePopular = async (options = {}) =>", self.script)
        self.assertIn("setFormValue(form, 'maxNumSeqs', 1);", self.script)
        self.assertIn("const selectLocalModelSource = (source) =>", self.script)
        self.assertIn("engine === 'VLLM' ? ['huggingface', 'preset', 'direct'] : ['preset', 'direct']", self.script)
        self.assertIn("artifact: selectedLocalArtifact() || null", self.script)
        self.assertIn("payload.local.artifact = data.get('artifact').trim();", self.script)
        self.assertIn("targetSupportsEngine(target, engine)", self.script)
        self.assertIn("computeTarget: computeTargetId", self.script)
        self.assertIn("const engine = selectedLocalEngine()", self.script)
        self.assertIn("engine\n", self.script)
        self.assertIn("if (computeTargetKind(computeTargetId) === 'gpu')", self.script)

    def test_installed_models_render_artifact_precision_and_quantization(self):
        self.assertIn("const modelArtifactMetadata = (local, status, modelPayload) =>", self.script)
        self.assertIn("appendModelMeta(meta, 'Artifact', artifact.id);", self.script)
        self.assertIn("appendModelMeta(meta, 'Format', artifact.format);", self.script)
        self.assertIn("appendModelMeta(meta, 'Precision', artifact.precision);", self.script)
        self.assertIn("appendModelMeta(meta, 'Quantization', quantizationLabel(artifact));", self.script)

    def test_system_status_shows_all_hardware_operator_lifecycle_states(self):
        self.assertIn("<h3>GPU Operators</h3>", self.source)
        self.assertIn('id="hardware-operator-list"', self.source)
        self.assertIn("(status || {}).hardwareOperators", self.script)
        self.assertIn("operator.operatorVersion", self.script)
        self.assertIn("operator.allocatableResources", self.script)
        self.assertIn("ready + ' ready / ' + active + ' active / ' + operators.length + ' known'", self.script)

    def test_instance_picker_exposes_unavailable_catalog_applications_safely(self):
        self.assertIn("form.dataset.instanceAvailable = installed ? 'true' : 'false'", self.script)
        self.assertIn("instanceTypeInstalled(modulePayload, form.dataset.instanceType)", self.script)
        self.assertIn("cataloguedInstanceForms().forEach((form)", self.script)
        self.assertIn("button.disabled = !available", self.script)
        self.assertIn("'Unavailable. Enable and wait for: '", self.script)
        self.assertIn("createPanel.hidden = cataloguedCount === 0", self.script)

    def test_successful_instance_creation_closes_the_dialog(self):
        handler = self.script.split("document.querySelectorAll('.instance-form').forEach((form) =>", 1)[1]
        handler = handler.split("document.querySelectorAll('input[data-gateway-toggle]')", 1)[0]
        request_line = "await request('/api/instances/' + type"
        close_line = "closeUserDialog($('instance-create-dialog'));"
        self.assertIn(request_line, handler)
        self.assertIn(close_line, handler)
        self.assertLess(handler.index(request_line), handler.index(close_line))

    def test_overview_url_discovery_matches_routes_and_excludes_callbacks(self):
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        start = self.script.index("const ensureHttpUrl")
        end = self.script.index("const copyText", start)
        functions = self.script[start:end]
        probe = functions + r"""
const statusPayload = {
  ingresses: [],
  httpRoutes: [
    { name: 'static-litellm-local', labels: {}, hostnames: ['litellm.magicstick.local'], accepted: true },
    { name: 'static-litellm-local-callback', labels: {}, hostnames: ['magicstick.local'], accepted: true },
    { name: 'static-litellm-pending', labels: { 'app.kubernetes.io/name': 'litellm' }, hostnames: ['pending.magicstick.example.com'], accepted: false },
    { name: 'openclaw-demo-local', labels: { 'appliance.magicstick.dev/appinstance': 'openclaw-demo' }, hostnames: ['demo.openclaw.magicstick.local'], accepted: true }
  ]
};
const moduleLinks = moduleAccessLinks('litellm', { activationMode: 'moduleactivation' }, statusPayload);
const instanceLinks = instanceAccessLinks({
  metadata: { name: 'openclaw-demo' },
  spec: { application: 'openclaw' },
  status: { phase: 'Ready' }
}, statusPayload);
process.stdout.write(JSON.stringify({
  module: moduleLinks.map((link) => link.url),
  instance: instanceLinks.map((link) => link.url)
}));
"""
        completed = subprocess.run(
            ["node"],
            input=probe,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        links = json.loads(completed.stdout)
        self.assertEqual(links["module"], ["https://litellm.magicstick.local"])
        self.assertEqual(links["instance"], ["https://demo.openclaw.magicstick.local"])

    def test_users_are_lazy_loaded_outside_the_global_refresh(self):
        refresh = self.script.split("const refresh = async () => {", 1)[1].split("document.querySelectorAll('.tab-button')", 1)[0]
        self.assertNotIn("/api/users", refresh)
        self.assertNotIn("/api/api-access", refresh)
        self.assertNotIn("/api/kubernetes-access", refresh)
        self.assertIn("if (button.dataset.tab === 'users')", self.script)
        self.assertIn("await loadUsers(false)", self.script)
        self.assertIn("if (button.dataset.tab === 'api-access')", self.script)
        self.assertIn("await loadApiAccess(false)", self.script)
        self.assertIn("if (button.dataset.tab === 'kubernetes-access')", self.script)
        self.assertIn("await loadKubernetesAccess(false)", self.script)

    def test_user_api_contract_and_csrf_header_are_present(self):
        for endpoint in (
            "/api/users?",
            "/api/users/",
            "/roles",
            "/password",
        ):
            self.assertIn(endpoint, self.script)
        for method in ("'POST'", "'PATCH'", "'PUT'", "'DELETE'"):
            self.assertIn("method: " + method, self.script)
        self.assertIn("headers['X-MagicStick-CSRF'] = 'dashboard'", self.script)
        self.assertIn("body: JSON.stringify({ usernameConfirmation })", self.script)

    def test_role_form_captures_access_before_disabling_controls(self):
        handler = self.script.split("const userRoleForm = $('user-role-form');", 1)[1]
        handler = handler.split("const userPasswordForm = $('user-password-form');", 1)[0]

        capture = "const data = new FormData(userRoleForm);"
        disable = "setDialogBusy(userRoleForm, true);"
        self.assertIn(capture, handler)
        self.assertIn("const accessLevel = String(data.get('accessLevel') || 'user');", handler)
        self.assertLess(handler.index(capture), handler.index(disable))
        self.assertIn("body: JSON.stringify({ accessLevel })", handler)

    def test_user_supplied_values_use_dom_text_not_html(self):
        user_code = self.script.split("const sessionIsUserAdmin", 1)[1].split("const renderStatus", 1)[0]
        self.assertNotIn("innerHTML", user_code)
        self.assertIn("textContent", user_code)
        self.assertIn("list.replaceChildren()", user_code)

    def test_model_preset_dropdown_uses_catalog_titles(self):
        self.assertIn("option.textContent = String(((presets[key] || {}).title || key));", self.script)

    def test_password_inputs_are_temporary_and_scrubbed(self):
        self.assertGreaterEqual(self.source.count('autocomplete="new-password"'), 4)
        self.assertIn("temporary: true", self.script)
        self.assertIn("clearPasswordInputs(userEditorForm)", self.script)
        self.assertIn("clearPasswordInputs(userPasswordForm)", self.script)

    def test_user_management_in_a_real_headless_browser(self):
        if os.environ.get("MAGICSTICK_RUN_BROWSER_TESTS") != "1":
            self.skipTest("set MAGICSTICK_RUN_BROWSER_TESTS=1 to run the Chrome DOM test")
        chrome = chrome_executable()
        if not chrome:
            self.skipTest("Chrome or Chromium is not installed")
        with tempfile.TemporaryDirectory(prefix="magicstick-dashboard-ui-") as temporary_directory:
            directory = Path(temporary_directory)
            page = directory / "dashboard-test.html"
            page.write_text(instrumented_dashboard_html(self.source), encoding="utf-8")
            scenarios = ("admin", "viewer", "operator", "unavailable")

            for scenario in scenarios:
                profile = directory / ("chrome-" + scenario)
                command = [
                    chrome,
                    "--headless=new",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-crash-reporter",
                    "--disable-default-apps",
                    "--disable-extensions",
                    "--disable-gpu",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--no-first-run",
                    "--no-sandbox",
                    "--allow-file-access-from-files",
                    "--virtual-time-budget=5000",
                    "--user-data-dir=" + str(profile),
                    "--dump-dom",
                    page.as_uri() + "?scenario=" + scenario,
                ]
                with self.subTest(scenario=scenario):
                    try:
                        completed = subprocess.run(
                            command,
                            text=True,
                            capture_output=True,
                            check=False,
                            timeout=10,
                        )
                        stdout = completed.stdout
                        stderr = completed.stderr
                        self.assertEqual(completed.returncode, 0, stderr[-4000:])
                    except subprocess.TimeoutExpired as error:
                        # Some macOS Chrome builds keep the headless parent
                        # process alive after --dump-dom. The DOM marker remains
                        # authoritative because it is written only after every
                        # browser assertion has completed.
                        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
                        stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or "")
                    match = re.search(
                        r'<pre id="browser-test-result" data-status="([^"]+)">([^<]*)</pre>',
                        stdout,
                    )
                    self.assertIsNotNone(match, stdout[-4000:] + stderr[-2000:])
                    self.assertEqual(match.group(1), "passed", match.group(2))
                    self.assertEqual(match.group(2), "passed:" + scenario)


if __name__ == "__main__":
    unittest.main()
