"""OTA firmware-update routes for the CANGateway backend.

Exposes:
    POST /ota/start    multipart: firmware (.bin), config (JSON)
    POST /ota/pause    pause active session(s)
    POST /ota/resume   resume after pause
    POST /ota/abort    abort active session(s)
    WS   /ws/ota?session=<id>   live phase / progress / board_status / log / finished
"""

from .routes import router

__all__ = ["router"]
