FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "src/index.js"]
