FROM docker.io/library/node:20-alpine

WORKDIR /app

COPY package.json ./

# The project claims zero external dependencies
# No need to run npm install if there are no dependencies

COPY . .

# Default port mentioned in README
EXPOSE 8990

USER nobody:nogroup
CMD ["node", "index.js"]