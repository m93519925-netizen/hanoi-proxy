const express = require('express');
const axios = require('axios');
const https = require('https');
const qs = require('qs');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const PORT = process.env.PORT || 3001;
const DEBUG = process.env.DEBUG === 'true';

// HTTPS Agent for self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  timeout: 30000
});

// ==================== UTILITIES ====================

/**
 * Get Antiforgery Token từ page
 */
async function getAntiforgeryToken() {
  try {
    const response = await axios.get(
      'https://tsdaucap.hanoi.gov.vn/tra-cuu-diem-thi-vao-10',
      {
        httpsAgent,
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
        }
      }
    );
    
    // Extract token từ HTML
    const tokenMatch = response.data.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/);
    const captchaMatch = response.data.match(/name="CaptchaTime"\s+value="([^"]+)"/);
    
    const token = tokenMatch ? tokenMatch[1] : null;
    const captchaTime = captchaMatch ? captchaMatch[1] : null;
    
    if (DEBUG) {
      console.log(`[DEBUG] Token: ${token?.substring(0, 50)}...`);
      console.log(`[DEBUG] CaptchaTime: ${captchaTime?.substring(0, 50)}...`);
    }
    
    return { token, captchaTime };
  } catch (err) {
    console.error('[ERROR] Get token failed:', err.message);
    return { token: null, captchaTime: null };
  }
}

/**
 * Get Captcha Image
 */
async function getCaptcha(captchaTime) {
  try {
    const response = await axios.get(
      'https://tsdaucap.hanoi.gov.vn/captcha',
      {
        params: { t: captchaTime || Date.now() },
        httpsAgent,
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://tsdaucap.hanoi.gov.vn/tra-cuu-diem-thi-vao-10'
        },
        responseType: 'arraybuffer'
      }
    );
    
    return Buffer.from(response.data).toString('base64');
  } catch (err) {
    console.error('[ERROR] Get captcha failed:', err.message);
    return null;
  }
}

/**
 * Parse điểm từ response
 */
function parseScore(text, subject) {
  const regex = new RegExp(`${subject}[:\\s]+([0-9,.]+)`, 'i');
  const match = text.match(regex);
  if (match) {
    return parseFloat(match[1].replace(',', '.'));
  }
  return null;
}

/**
 * Parse response
 */
function parseResponse(sbd, respData) {
  try {
    if (!respData || !respData.result) {
      return null;
    }
    
    const kq = respData.kq || {};
    const diemThi = kq.diemThi || '';
    
    const van = parseScore(diemThi, 'Ngữ văn|Văn');
    const anh = parseScore(diemThi, 'Ngoại ngữ|Anh');
    const toan = parseScore(diemThi, 'Toán');
    const tong = parseScore(diemThi, 'Tổng điểm XT|Tổng');
    const chuyen1 = parseScore(diemThi, 'Chuyên 1');
    const chuyen2 = parseScore(diemThi, 'Chuyên 2');
    
    return {
      soBaoDanh: kq.soBaoDanh || sbd,
      maHocSinh: kq.maHocSinh || '',
      hoTen: kq.hoTen || '',
      van,
      anh,
      toan,
      tongDiem: tong,
      chuyen1,
      chuyen2,
      rawText: diemThi
    };
  } catch (err) {
    console.error('[ERROR] Parse response failed:', err.message);
    return null;
  }
}

/**
 * Fetch with retry
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios({
        ...options,
        url,
        timeout: 15000,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...options.headers
        }
      });
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        if (DEBUG) console.log(`[DEBUG] Retry ${attempt}/${maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

// ==================== ROUTES ====================

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * POST /api/search
 * Search score by SBD (Hà Nội version)
 */
app.post('/api/search', async (req, res) => {
  try {
    const { soBaoDanh, captchaInput } = req.body;
    
    if (!soBaoDanh) {
      return res.status(400).json({ error: 'Missing soBaoDanh' });
    }
    
    if (!captchaInput) {
      return res.status(400).json({ error: 'Missing captchaInput' });
    }
    
    console.log(`[SEARCH] SBD: ${soBaoDanh}`);
    
    // Get token + captcha time
    console.log('[TOKEN] Getting antiforgery token...');
    const { token, captchaTime } = await getAntiforgeryToken();
    
    if (!token) {
      return res.status(500).json({ error: 'Failed to get token' });
    }
    
    // Prepare form data
    const formData = qs.stringify({
      'LOAI_TRA_CUU': '01',
      'GIA_TRI': String(soBaoDanh).trim(),
      'CaptchaTime': captchaTime || '',
      'CaptchaInput': captchaInput,
      '__RequestVerificationToken': token
    });
    
    if (DEBUG) {
      console.log('[DEBUG] Form data prepared');
    }
    
    // Send search request
    console.log('[SEARCH] Sending request to HN server...');
    const searchRes = await fetchWithRetry(
      'https://tsdaucap.hanoi.gov.vn/tra-cuu-diem-thi-10',
      {
        method: 'POST',
        data: formData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://tsdaucap.hanoi.gov.vn/tra-cuu-diem-thi-vao-10',
          'Origin': 'https://tsdaucap.hanoi.gov.vn',
          'X-Requested-With': 'XMLHttpRequest'
        }
      }
    );
    
    if (DEBUG) {
      console.log('[DEBUG] Response status:', searchRes.status);
    }
    
    // Parse response
    const result = parseResponse(soBaoDanh, searchRes.data);
    
    if (result) {
      console.log(`[SUCCESS] ${result.soBaoDanh} - ${result.hoTen}`);
      return res.json({ data: result });
    } else {
      console.error('[ERROR] Failed to parse response');
      return res.status(400).json({
        error: 'Invalid response from server',
        details: searchRes.data
      });
    }
  } catch (err) {
    console.error('[ERROR] POST /api/search:', err.message);
    return res.status(500).json({
      error: err.message,
      details: DEBUG ? err.stack : undefined
    });
  }
});

/**
 * GET /api/captcha-image
 */
app.get('/api/captcha-image', async (req, res) => {
  try {
    const { token, captchaTime } = await getAntiforgeryToken();
    
    if (!captchaTime) {
      return res.status(500).json({ error: 'Failed to get captcha time' });
    }
    
    const captchaBase64 = await getCaptcha(captchaTime);
    
    if (!captchaBase64) {
      return res.status(500).json({ error: 'Failed to get captcha' });
    }
    
    res.json({
      image: `data:image/png;base64,${captchaBase64}`,
      captchaTime,
      token
    });
  } catch (err) {
    console.error('[ERROR] GET /api/captcha-image:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/status
 */
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    server: 'Hanoi Proxy Server',
    debug: DEBUG,
    timestamp: new Date().toISOString()
  });
});

// ==================== ERROR HANDLING ====================

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    error: 'Internal server error',
    message: DEBUG ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'═'.repeat(75)}`);
  console.log(`🚀 HANOI PROXY SERVER`);
  console.log(`${'═'.repeat(75)}`);
  console.log(`\n📍 Server: http://0.0.0.0:${PORT}`);
  console.log(`🔍 Debug Mode: ${DEBUG ? 'ON' : 'OFF'}`);
  console.log(`\n🔗 Available Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /api/status`);
  console.log(`   POST /api/search`);
  console.log(`   GET  /api/captcha-image`);
  console.log(`\n💡 Test:`);
  console.log(`   curl http://0.0.0.0:${PORT}/health`);
  console.log(`\n🌐 To expose via zrok:`);
  console.log(`   zrok share public http://localhost:${PORT}`);
  console.log(`\n⚠️  NOTE: Requires manual captcha input`);
  console.log(`${'═'.repeat(75)}\n`);
});

module.exports = app;
