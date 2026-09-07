# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
FROM node:24-alpine
WORKDIR /app
COPY run.test.mjs .
USER node
# --test-force-exit: node:test otherwise waits on the keep-alive fetch agent.
ENTRYPOINT ["node", "--test", "--test-force-exit", "run.test.mjs"]
