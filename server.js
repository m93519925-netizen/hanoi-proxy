const express = require('express');
const axios = require('axios');
const https = require('https');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const app = express();
app.use(express.json());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const BASE = 'https://tsdaucap.hanoi.gov.vn';

// ============================================================
// Endpoint duy nhất: nhận SBD → trả kết quả điểm luôn
// Toàn bộ session (cookie + token + captcha + submit) 
// xử lý trong 1 request duy nhất → tránh lỗi session lệch
// ============================================================
app.post('/tracuu', async (req, res) => {
  const { sbd } = req.body;
  if (!sbd) return res.status(400).json({ error: 'Thiếu sbd' });

  // Mỗi lần gọi tạo 1 cookie jar riêng → session độc lập
  const jar = new tough.CookieJar();
  const client = wrapper(axios.create({
    httpsAgent,
    jar,
    withCredentials: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  }));

  try {
    // ── Bước 1: GET trang chủ → lấy AntiForgery token + cookie session ──
    const homePage = await client.get(`${BASE}/tra-cuu-diem-thi-vao-10`);

    const tokenMatch = homePage.data.match(
      /name="__RequestVerificationToken"[^>]*value="([^"]+)"/
    );
    if (!tokenMatch) {
      return res.status(500).json({ error: 'Không tìm thấy AntiForgery token trong HTML' });
    }
    const antiForgeryToken = tokenMatch[1];

    // ── Bước 2: GET captcha → lấy time + ảnh base64 ──
    const captchaRes = await client.get(`${BASE}/getcaptcha?_=${Date.now()}`);
    const { time: captchaTime, image: captchaImage } = captchaRes.data;

    if (!captchaTime || !captchaImage) {
      return res.status(500).json({ error: 'Không lấy được captcha' });
    }

    // ── Trả về cho Colab để giải captcha OCR ──
    // Colab sẽ gọi /submit với captchaInput sau khi giải
    return res.json({
      ok: true,
      sbd,
      antiForgeryToken,
      captchaTime,
      captchaImage,
      // Serialize cookie jar để dùng lại trong /submit
      cookies: await jar.serialize(),
    });

  } catch (err) {
    console.error(`[tracuu] ${sbd}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Endpoint submit: nhận captchaInput từ Colab → POST lên server
// ============================================================
app.post('/submit', async (req, res) => {
  const { sbd, antiForgeryToken, captchaTime, captchaInput, cookies } = req.body;

  if (!sbd || !antiForgeryToken || !captchaTime || !captchaInput) {
    return res.status(400).json({ error: 'Thiếu tham số' });
  }

  try {
    // Khôi phục cookie jar từ session trước
    const jar = await tough.CookieJar.deserialize(cookies || { version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] });
    const client = wrapper(axios.create({
      httpsAgent,
      jar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      }
    }));

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
    console.error(`[submit] ${sbd}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Health check ──
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Proxy chạy tại http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
