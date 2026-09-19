# 主推理服务（TTS / ASR / VAD）—— 端口 8765
#
# ★ 这个镜像里**不含 CosyVoice 模型**，故意的：
#   · 模型权重约 4GB，而且受各自许可约束，不该塞进镜像
#   · 它要 GPU，Windows 上还得先装 WSL2 + nvidia-container-toolkit
#   · 本地模型那条路本来就是"我自己机器上的音色"，不是给别人跑的
#
#   所以容器里跑的是**线上 TTS**（edge / openai 那类）——
#   纯 CPU、只要有网就能跑。要本地模型就在宿主机上跑 `tools/start-all.cmd`。
#
# 构建：docker build -f python/Dockerfile -t nexus-service .

FROM python:3.12-slim

# uvloop 之类的轮子要编译时用到；装完就删，别留在最终镜像里
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷依赖清单 —— 这样改代码不会让依赖层缓存失效
COPY python/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    # edge-tts 是可选的线上引擎（免费、不用 key），装进镜像当默认
    && pip install --no-cache-dir edge-tts

COPY python/ ./python/

# ★ 工作目录必须切到 python/ —— 启动命令是 `python -m service.main`，
#   而模块在 /app/python/service/。停在 /app 的话直接 `No module named service`。
#   （本地 tools\start-all.ps1 也是用 -WorkDir python 起的，同一个道理。）
WORKDIR /app/python

# 音色素材是**用户自己的**，构建时不带进来，运行时挂载（见 compose 的 volumes）
ENV NEXUS_VOICES_DIR=/app/python/voices \
    PYTHONIOENCODING=utf-8 \
    PYTHONUNBUFFERED=1 \
    NEXUS_PORT=8765 \
    NEXUS_TTS_ENGINE=edge

EXPOSE 8765

# 探活走 127.0.0.1 —— 这是**容器内部**自己探自己，服务监听 0.0.0.0 已经包含它了。
# （容易搞混的是另一件事：服务**必须**监听 0.0.0.0，否则宿主机端口映射进来的流量会被拒。
#   那是监听地址的问题，不是探活地址的问题。）
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8765/health',timeout=4)"

CMD ["python", "-m", "service.main"]
