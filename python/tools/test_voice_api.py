"""模拟界面上的「添加音色」：走主服务 → 模型服务，验证整条克隆链路。

界面就是这么调的（读文件 → base64 → POST /voices），这里用 CosyVoice 自带的
示例音频当"用户上传的录音"，省得依赖真的录音文件。
"""

import base64
import io
import json
import time
import urllib.request
import wave

import numpy as np

MAIN = "http://127.0.0.1:8790"
PROMPT = r"D:\cosyvoice\asset\zero_shot_prompt.wav"
TRANSCRIPT = "希望你以后能够做的比我还好呦。"


def post(url: str, payload: dict, timeout: int = 120):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(url: str):
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


print("1. 注册前音色列表:", get(f"{MAIN}/voices")["voices"])

raw = open(PROMPT, "rb").read()
b64 = "data:audio/wav;base64," + base64.b64encode(raw).decode("ascii")
print(f"2. 上传参考音频 {len(raw)/1024:.0f}KB → POST /voices")

t0 = time.time()
res = post(f"{MAIN}/voices", {"name": "testvoice", "text": TRANSCRIPT, "wav_base64": b64})
print(f"   注册耗时 {time.time()-t0:.2f}s → 音色列表: {res['voices']}")

print("3. 用新音色合成（主服务 → 模型服务）")
t1 = time.time()
req = urllib.request.Request(
    f"{MAIN}/tts",
    data=json.dumps({"text": "你好，这是用刚注册的音色说的话。", "voice": "testvoice", "speed": 1.0}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=180) as resp:
    wav = resp.read()
dt = time.time() - t1

w = wave.open(io.BytesIO(wav))
pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32767
print(f"   {dt:.2f}s → 音频 {w.getnframes()/w.getframerate():.2f}s @ {w.getframerate()}Hz，峰值 {abs(pcm).max():.2f}")

print("4. 清理测试音色")
req = urllib.request.Request(f"{MAIN}/voices/testvoice", method="DELETE")
with urllib.request.urlopen(req, timeout=30) as resp:
    print("   删除后:", json.loads(resp.read().decode("utf-8"))["voices"])
