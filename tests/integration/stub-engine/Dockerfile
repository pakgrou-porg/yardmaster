# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
FROM node:24-alpine
WORKDIR /app
COPY server.mjs .
USER node
ENTRYPOINT ["node", "server.mjs"]
