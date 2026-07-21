FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3000
ENV DB_PATH=/app/data/statuses.db

EXPOSE 3000

CMD ["node", "server.js"]
