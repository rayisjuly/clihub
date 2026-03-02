FROM node:20-slim

RUN apt-get update && apt-get install -y jq curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 5678

VOLUME ["/app/data", "/projects"]

CMD ["node", "server.js"]
