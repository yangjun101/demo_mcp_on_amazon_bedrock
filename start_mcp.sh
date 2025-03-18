#!/bin/bash
export $(grep -v '^#' .env | xargs)

source .venv/bin/activate

mkdir -p ./tmp
mkdir -p ${LOG_DIR}

host=${MCP_SERVICE_HOST}
port=${MCP_SERVICE_PORT}
export USER_MCP_CONFIG_FILE=conf/user_mcp_configs.json

lsof -t -i:$port | xargs kill -9 2> /dev/null
python src/main.py --mcp-conf conf/config.json --user-conf conf/user_mcp_config.json \
    --host ${host} --port ${port} > ${LOG_DIR}/start_mcp.log 2>&1 &
