## Logic & Data

Ticketing logic & data follows 2 paths:

1. Per-ticket data
    - Each individual ticket's data is stored in a pinned comment as base64 encoded JSON, we do not store ticket info in a database
    - All interactions with tickets use this state and discord APIs
2. Server ticketing config/data
    - Server ticketing config/setup state is stored in the database as a ticketing config entity
    - All interactions with this use internal logic and our database
    - All interactions with this should update an embed
