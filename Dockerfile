FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js xlsx.js ./
COPY public ./public
ENV PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.js"]
