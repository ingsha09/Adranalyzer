import express from 'express';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = [
  'https://aranalyzer.blogspot.com',
  'https://www.aranalyzer.blogspot.com',
  'http://localhost:8080',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Allow all Replit URLs
    if (origin.includes('.replit.dev') || origin.includes('.repl.co')) {
      return callback(null, true);
    }

    // Check against allowed origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error(`CORS policy does not allow access from: ${origin}`), false);
  }
}));

app.use(express.json());

async function fetchWithRedirects(url, options = {}, maxRedirects = 5) {
  let finalUrl = url;
  let response;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      response = await fetch(finalUrl, { 
        ...options, 
        redirect: 'manual', 
        signal: controller.signal 
      });
      clearTimeout(timeoutId);
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        const location = response.headers.get('location');
        finalUrl = new URL(location, finalUrl).href;
        console.log(`Redirecting to: ${finalUrl}`);
      } else {
        break;
      }
    } catch (error) {
      console.error(`Redirect fetch error at ${finalUrl}:`, error.message);
      throw error;
    }
  }
  return fetch(finalUrl, options);
}

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.post('/api/analyze-url', async (req, res) => {
  const { url: initialUrl } = req.body;
  if (!initialUrl) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  let checks = [];
  let score = 0;
  let doc;
  let finalResolvedUrl;

  try {
    let targetUrl = initialUrl;
    if (!targetUrl.startsWith('http')) {
      targetUrl = `https://${targetUrl}`;
    }

    let htmlResponse;
    try {
      htmlResponse = await fetchWithRedirects(targetUrl);
      if (!htmlResponse.ok) {
        if (targetUrl.startsWith('https://')) {
          targetUrl = targetUrl.replace('https://', 'http://');
          htmlResponse = await fetchWithRedirects(targetUrl);
        }
      }
      if (!htmlResponse.ok) {
        throw new Error(`Fetch failed with status: ${htmlResponse.status}`);
      }
    } catch (error) {
      return res.status(500).json({ error: `Failed to fetch: ${error.message}` });
    }

    finalResolvedUrl = htmlResponse.url;
    const html = await htmlResponse.text();
    const dom = new JSDOM(html);
    doc = dom.window.document;

    const CAT_AUTO = 'Automated Technical Checks';
    const CAT_STRUCT_ACC = 'Site Structure & Accessibility';
    const CAT_MANUAL = 'Manual Checks for Content Quality';

    const runCheck = (name, category, weight, checkFn) => {
      const result = checkFn();
      checks.push({ name, category, ...result });
      if (result.status === 'pass') score += weight;
      else if (result.status === 'warn') score += weight / 2;
    };

    const findLink = (keywords, contextDoc = doc) =>
      Array.from(contextDoc.querySelectorAll('a')).find(link => {
        const href = link.href.toLowerCase();
        const text = link.textContent.toLowerCase();
        return keywords.some(keyword => href.includes(keyword) || text.includes(keyword));
      });

    runCheck('Secure Connection (HTTPS/SSL)', CAT_AUTO, 15, () => {
      return finalResolvedUrl.startsWith('https://')
        ? { status: 'pass', message: 'Site uses HTTPS.' }
        : { status: 'fail', message: 'Site does not use HTTPS.' };
    });

    runCheck('HTTPS Redirect Check', CAT_AUTO, 10, () => {
      const initial = new URL(initialUrl.startsWith('http') ? initialUrl : `https://${initialUrl}`);
      const final = new URL(finalResolvedUrl);
      if (initial.protocol === 'http:' && final.protocol === 'https:' && initial.hostname === final.hostname) {
        return { status: 'pass', message: 'HTTP correctly redirects to HTTPS.' };
      }
      return { status: 'warn', message: 'HTTP to HTTPS redirect unclear or missing.' };
    });

    runCheck('Descriptive Title Tag', CAT_AUTO, 5, () => {
      const title = doc.querySelector('title')?.textContent.trim();
      return title && title.length >= 15 && title.length <= 60
        ? { status: 'pass', message: `Title found: "${title}"` }
        : { status: 'fail', message: `Title is too short/long or missing. Current: "${title || 'N/A'}"` };
    });

    const robotsCheckResult = await (async () => {
      try {
        const origin = new URL(finalResolvedUrl).origin;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const robotsRes = await fetch(`${origin}/robots.txt`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!robotsRes.ok) {
          return { status: 'warn', message: 'robots.txt not found or inaccessible.' };
        }
        const text = await robotsRes.text();
        const blocked = /User-agent:.*(Googlebot|AdsBot-Google|\*)\s*Disallow:\s*\/$/im.test(text);
        if (blocked) {
          return { status: 'fail', message: 'robots.txt blocks search bots. Critical issue.' };
        }
        return { status: 'pass', message: 'robots.txt OK.' };
      } catch (e) {
        return { status: 'fail', message: 'Error analyzing robots.txt.' };
      }
    })();

    checks.push({ name: 'Robots.txt Configuration', category: CAT_AUTO, weight: 10, ...robotsCheckResult });
    if (robotsCheckResult.status === 'pass') score += 10;
    else if (robotsCheckResult.status === 'warn') score += 5;

    runCheck('Clear Navigation Menu', CAT_STRUCT_ACC, 8, () => {
      const nav = doc.querySelector('nav');
      return nav && nav.querySelectorAll('a').length >= 3
        ? { status: 'pass', message: 'Navigation menu found.' }
        : { status: 'fail', message: 'No clear nav menu or too few links.' };
    });

    runCheck('Privacy Policy Page', CAT_STRUCT_ACC, 12, () => {
      return findLink(['privacy', 'policy']) ?
        { status: 'pass', message: 'Privacy Policy link found.' } :
        { status: 'fail', message: 'Privacy Policy link missing.' };
    });

    runCheck('About Us & Contact Pages', CAT_STRUCT_ACC, 10, () => {
      const hasAbout = findLink(['about']);
      const hasContact = findLink(['contact']);
      if (hasAbout && hasContact) {
        return { status: 'pass', message: 'About & Contact pages found.' };
      } else if (hasAbout || hasContact) {
        return { status: 'warn', message: `Missing ${hasAbout ? 'Contact' : 'About'} page.` };
      }
      return { status: 'fail', message: 'Both About and Contact pages missing.' };
    });

    runCheck('Mobile Responsiveness (Viewport Meta Tag)', CAT_STRUCT_ACC, 8, () => {
      const meta = doc.querySelector('meta[name="viewport"]');
      return meta && meta.content.includes('width=device-width')
        ? { status: 'pass', message: 'Viewport tag found. Mobile-friendly.' }
        : { status: 'fail', message: 'Missing or incorrect viewport tag.' };
    });

    runCheck('Language Declaration (`lang` attribute)', CAT_STRUCT_ACC, 5, () => {
      const lang = doc.documentElement.getAttribute('lang');
      return lang
        ? { status: 'pass', message: `Language declared: "${lang}"` }
        : { status: 'warn', message: 'No HTML lang attribute.' };
    });

    runCheck('Favicon Present', CAT_STRUCT_ACC, 2, () => {
      const link = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
      return link && link.href
        ? { status: 'pass', message: 'Favicon present.' }
        : { status: 'warn', message: 'Favicon missing.' };
    });

    runCheck('Common Broken Link Patterns', CAT_STRUCT_ACC, 5, () => {
      const text = doc.body.textContent.toLowerCase();
      if (text.includes('404') || text.includes('page not found')) {
        return { status: 'fail', message: 'Potential broken link or 404 page detected.' };
      }
      return { status: 'pass', message: 'No obvious broken links.' };
    });

    checks.push({ name: 'Content Originality', category: CAT_MANUAL, status: 'manual', message: 'Is the content original and unique?' });
    checks.push({ name: 'E-E-A-T', category: CAT_MANUAL, status: 'manual', message: 'Does the site show experience, expertise, authority, trust?' });

    res.json({ score: Math.min(100, Math.round(score)), checks, finalResolvedUrl });

  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: `Server error: ${error.message}` });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is running on http://0.0.0.0:${PORT}`);
});