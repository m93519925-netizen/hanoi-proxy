const express = require('express');
const axios = require('axios');
const tough = require('tough-cookie');
const { HttpCookieAgent, HttpsCookieAgent } = require('http-cookie-agent/http');

const app = express();
app.use(express.json());
const BASE = 'https://tsdaucap.hanoi.gov.vn';

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/tracuu', async (req, res) => {
  const { sbd } = req.body;
  if (!sbd) return res.status(400).json({ error: 'Thieu sbd' });

  const jar = new tough.CookieJar();
  const client = axios.create({
    httpAgent:  new HttpCookieAgent({ cookies: { jar } }),
    httpsAgent: new HttpsCookieAgent({ cookies: { jar }, rejectUnauthorized: false }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
      'Accept-Language': 'vi-VN,vi;q=0.9',
    }
  });

  try {
    const homePage = await client.get(`${BASE}/tra-cuu-diem-thi-vao-10`);
    const tokenMatch = homePage.data.match(
      /name="__RequestVerificationToken"[^>]*value="([^"]+)"/
    );
    if (!tokenMatch) return res.status(500).json({ error: 'Khong tim thay token' });
    const antiForgeryToken = tokenMatch[1];

    const captchaRes = await client.get(`${BASE}/getcaptcha?_=${Date.now()}`);
    const { time: captchaTime, image: captchaImage } = captchaRes.data;
    if (!captchaTime || !captchaImage) return res.status(500).json({ error: 'Khong lay duoc captcha' });

    return res.json({
      ok: true,
      sbd,
      antiForgeryToken,
      captchaTime,
      captchaImage,
      cookies: await jar.serialize(),
    });

  } catch (err) {
    console.error('[tracuu]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/submit', async (req, res) => {
  const { sbd, antiForgeryToken, captchaTime, captchaInput, cookies } = req.body;
  if (!sbd || !captchaInput) return res.status(400).json({ error: 'Thieu tham so' });

  let jar;
  try {
    jar = await tough.CookieJar.deserialize(cookies);
  } catch (e) {
    jar = new tough.CookieJar();
  }

  const client = axios.create({
    httpAgent:  new HttpCookieAgent({ cookies: { jar } }),
    httpsAgent: new HttpsCookieAgent({ cookies: { jar }, rejectUnauthorized: false }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
      'Accept-Language': 'vi-VN,vi;q=0.9',
    }
  });

  try {
    const params = new URLSearchParams();
    params.append('LOAI_TRA_CUU', '02');
    params.append('GIA_TRI', sbd);
    params.append('CaptchaTime', captchaTime);
    params.append('CaptchaInput', captchaInput);

    const result = await client.post(`${BASE}/tra-cuu-diem-thi-10`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'RequestVerificationToken': antiForgeryToken,
        'Referer': `${BASE}/tra-cuu-diem-thi-vao-10`,
        'Origin': BASE,
      }
    });

    return res.json(result.data);

  } catch (err) {
    console.error('[submit]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('✅ Proxy chay tai http://localhost:3000');
  console.log('   Health: http://localhost:3000/health');
});
