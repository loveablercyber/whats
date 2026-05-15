FROM ghcr.io/puppeteer/puppeteer:latest

USER root

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN chown -R pptruser:pptruser /app

USER pptruser

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]