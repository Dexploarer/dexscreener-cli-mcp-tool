# Daemon Deployment Guide

This guide shows how to run task scheduling continuously.

## Linux (systemd)

## 1) Create a service unit
File: `/etc/systemd/system/dexplorer-task-daemon.service`

```ini
[Unit]
Description=Dexplorer Task Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/dexplorer-cli-mcp-tool
ExecStart=/path/to/dexplorer-cli-mcp-tool/.venv/bin/ds task daemon --all --poll-seconds 5 --default-interval-seconds 120
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

## 2) Enable and start
```bash
sudo systemctl daemon-reload
sudo systemctl enable dexplorer-task-daemon
sudo systemctl start dexplorer-task-daemon
```

## 3) Inspect logs
```bash
sudo journalctl -u dexplorer-task-daemon -f
```

## Windows (Task Scheduler)

## 1) Program/script
Use:
`C:\path\to\dexplorer-cli-mcp-tool\.venv\Scripts\ds.exe`

## 2) Arguments
Use:
`task daemon --all --poll-seconds 5 --default-interval-seconds 120`

## 3) Start in
Use:
`C:\path\to\dexplorer-cli-mcp-tool`

## 4) Trigger
1. At startup, or
2. At log on

## 5) Recovery behavior
In task settings:
1. Restart on failure.
2. Stop task if runs longer than disabled (daemon is long-lived).

## Operational tips
1. Keep only active tasks in `todo`.
2. Set broken tasks to `blocked` to avoid loop noise.
3. Use `ds task runs --limit 100` to audit execution and alert behavior.
4. Use `ds task test-alert <task> --no-with-scan` before enabling live alerts.
