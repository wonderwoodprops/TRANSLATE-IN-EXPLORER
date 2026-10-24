# תמונה רשמית של Playwright: כוללת את Chromium ואת כל התלויות שלו.
# הגרסה חייבת להיות זהה לגרסת playwright ב-package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
