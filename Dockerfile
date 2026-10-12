# POC image for the Streamable HTTP transport (run it next to collectory, behind the same proxy).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV HOST=0.0.0.0 PORT=3921
EXPOSE 3921
USER node
CMD ["node", "--import", "tsx", "src/http.ts"]
