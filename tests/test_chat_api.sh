curl http://127.0.0.1:7002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 123456" \
  -d '{
    "model": "us.amazon.nova-pro-v1:0",
    "mcp_server_ids":["db_sqlite","local_fs"],
    "messages": [
      {
        "role": "user",
        "content": "show all of tables in db"
      }
    ]
  }'

