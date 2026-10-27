FROM node:24-bookworm-slim

WORKDIR /app

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/mani.sqlite

RUN mkdir -p /data

EXPOSE 3000

CMD ["npm", "run", "start:production"]
