#!/usr/bin/env bash
# Create + start the utai sandbox container.
#
# --shm-size=2g: the default 64MB /dev/shm makes PyTorch DataLoader workers
# (num_workers>0) hang/OOM when they share tensors; 2g gives prefetch room.
# shm size is fixed at creation, so changing it means recreating the container:
#   sudo docker stop utai-sandbox && sudo docker rm utai-sandbox && sandbox/start.sh
# -v .../models-cache:/models persists the model caches (HF, torch,
# audio-separator) on the workspace volume so they survive container recreates --
# /models is otherwise container-local and wiped on every rm (re-fetch each time).
# The repo is bind-mounted at the SAME absolute path in-container so temp files
# Write()n in the repo (and `sandbox-py FILE.py`) resolve identically.
# Inherit the HOST's effective timezone (the TZ env var when set, else the
# system zone) so in-container timestamps (runner logs, `date`, Python
# localtime) match the host instead of the image's UTC.
HOST_TZ="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo Etc/UTC)}"
sudo docker run -d --name utai-sandbox --gpus all --shm-size=2g \
  -e TZ="$HOST_TZ" \
  -v /home/bitnimble/code/utai.au:/home/bitnimble/code/utai.au \
  -v /codebox-workspace:/codebox-workspace \
  -v /codebox-workspace/utai/models-cache:/models \
  utai-sandbox
