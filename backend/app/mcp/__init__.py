"""MCP package — Model Context Protocol server for PomodoroXII.

Exposes PomodoroXII's Service layer (stats, meta, sync) as MCP tools,
resources, and prompts so that LLM agents (Claude Desktop, Cursor, etc.)
can interact with the application's data.

All Service classes are already MCP-ready (no FastAPI dependency, dict
params, flush-only). This package only adds the MCP protocol wrapper.
"""
