import express from 'express';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'https://adranalyzer.blogspot.com',
  'https://www.adranalyzer.blogspot.com',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  'https://adranalyzer.blogspot.com',
  'https://adranalyzer.onrender.com'
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

// Enhanced fetch with better error handling and user agent
async function fetchWithRedirects(url, options = {}, maxRedirects = 5) {
  let finalUrl = url;
  let response;

  const defaultOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      ...options.headers
    },
    ...options
  };

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      response = await fetch(finalUrl, {
        ...defaultOptions,
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
      console.error(`Fetch error at ${finalUrl}:`, error.message);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout - website took too long to respond');
      }
      throw error;
    }
  }

  return fetch(finalUrl, defaultOptions);
}



// Health check endpoint similar to your example
app.get('/health', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send("Hello from your Node.js backend! I'm alive!\n");
});

app.post('/api/analyze-url', async (req, res) => {
  const { url: initialUrl } = req.body;

  if (!initialUrl) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  // Enhanced URL validation
  let targetUrl = initialUrl.trim();
  if (!targetUrl.match(/^https?:\/\//)) {
    targetUrl = `https://${targetUrl}`;
  }

  try {
    new URL(targetUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL format provided.' });
  }

  let checks = [];
  let score = 0;
  let doc;
  let finalResolvedUrl;
  let responseTime = Date.now();

  try {
    let htmlResponse;

    try {
      htmlResponse = await fetchWithRedirects(targetUrl);
      responseTime = Date.now() - responseTime;

      if (!htmlResponse.ok) {
        if (targetUrl.startsWith('https://')) {
          console.log('HTTPS failed, trying HTTP...');
          targetUrl = targetUrl.replace('https://', 'http://');
          htmlResponse = await fetchWithRedirects(targetUrl);
        }
      }

      if (!htmlResponse.ok) {
        throw new Error(`Server responded with status ${htmlResponse.status}: ${htmlResponse.statusText}`);
      }
    } catch (error) {
      console.error('Fetch error:', error);
      return res.status(500).json({
        error: `Failed to access website: ${error.message}. Please check if the URL is correct and the website is accessible.`
      });
    }

    finalResolvedUrl = htmlResponse.url;
    const contentType = htmlResponse.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) {
      return res.status(400).json({
        error: 'The URL does not point to an HTML webpage. Please provide a valid website URL.'
      });
    }

    const html = await htmlResponse.text();

    if (!html || html.length < 100) {
      return res.status(400).json({
        error: 'Website returned empty or minimal content. Please check if the URL is correct.'
      });
    }

    try {
      const dom = new JSDOM(html);
      doc = dom.window.document;
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to parse website HTML. The website may have malformed content.'
      });
    }

    const CAT_AUTO = 'Automated Technical Checks';
    const CAT_STRUCT_ACC = 'Site Structure & Accessibility';
    const CAT_CONTENT = 'Content Quality Indicators';
    const CAT_PERFORMANCE = 'Performance & SEO';

    const runCheck = (name, category, weight, checkFn) => {
      try {
        const result = checkFn();
        checks.push({ name, category, weight, ...result });
        if (result.status === 'pass') score += weight;
        else if (result.status === 'warn') score += weight / 2;
      } catch (error) {
        checks.push({
          name,
          category,
          weight,
          status: 'fail',
          message: `Check failed: ${error.message}`
        });
      }
    };

    const findLink = (keywords, contextDoc = doc) =>
      Array.from(contextDoc.querySelectorAll('a')).find(link => {
        const href = (link.href || '').toLowerCase();
        const text = (link.textContent || '').toLowerCase();
        return keywords.some(keyword => href.includes(keyword) || text.includes(keyword));
      });

    // Enhanced HTTPS check
    runCheck('Secure Connection (HTTPS/SSL)', CAT_AUTO, 20, () => {
      if (finalResolvedUrl.startsWith('https://')) {
        return { status: 'pass', message: 'Site uses HTTPS encryption.' };
      } else {
        return { status: 'fail', message: 'Site does not use HTTPS. This is CRITICAL for AdSense approval.' };
      }
    });

    // HTTPS redirect check
    runCheck('HTTPS Redirect Check', CAT_AUTO, 15, () => {
      const initial = new URL(initialUrl.startsWith('http') ? initialUrl : `https://${initialUrl}`);
      const final = new URL(finalResolvedUrl);
      if (initial.protocol === 'http:' && final.protocol === 'https:' && initial.hostname === final.hostname) {
        return { status: 'pass', message: 'HTTP correctly redirects to HTTPS.' };
      } else if (final.protocol === 'https:') {
        return { status: 'pass', message: 'Site uses HTTPS.' };
      }
      return { status: 'fail', message: 'No HTTP to HTTPS redirect configured.' };
    });

    // Enhanced title check
    runCheck('SEO Title Tag', CAT_PERFORMANCE, 8, () => {
      const title = doc.querySelector('title')?.textContent?.trim();
      if (!title) {
        return { status: 'fail', message: 'Missing title tag - critical for SEO.' };
      }
      if (title.length < 10) {
        return { status: 'fail', message: `Title too short (${title.length} chars). Should be 15-60 characters.` };
      }
      if (title.length > 60) {
        return { status: 'warn', message: `Title too long (${title.length} chars). Consider shortening to under 60 characters.` };
      }
      return { status: 'pass', message: `Good title length: "${title}" (${title.length} chars)` };
    });

    // Meta description check
    runCheck('Meta Description', CAT_PERFORMANCE, 6, () => {
      const metaDesc = doc.querySelector('meta[name="description"]')?.content?.trim();
      if (!metaDesc) {
        return { status: 'fail', message: 'Missing meta description - important for SEO.' };
      }
      if (metaDesc.length < 120) {
        return { status: 'warn', message: `Meta description short (${metaDesc.length} chars). Consider 150-160 characters.` };
      }
      if (metaDesc.length > 160) {
        return { status: 'warn', message: `Meta description long (${metaDesc.length} chars). May be truncated in search results.` };
      }
      return { status: 'pass', message: `Good meta description length (${metaDesc.length} chars).` };
    });

    // Enhanced robots.txt check
    const robotsCheckResult = await (async () => {
      try {
        const origin = new URL(finalResolvedUrl).origin;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const robotsRes = await fetch(`${origin}/robots.txt`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AdSense-Analyzer-Bot/1.0' }
        });

        clearTimeout(timeoutId);

        if (!robotsRes.ok) {
          return { status: 'warn', message: 'robots.txt not found. Consider adding one for better SEO.' };
        }

        const text = await robotsRes.text();

        // Check for blocking patterns
        const blockingPatterns = [
          /User-agent:\s*\*\s*Disallow:\s*\/$/im,
          /User-agent:\s*Googlebot\s*Disallow:\s*\/$/im,
          /User-agent:\s*AdsBot-Google\s*Disallow:\s*\/$/im
        ];

        const isBlocked = blockingPatterns.some(pattern => pattern.test(text));

        if (isBlocked) {
          return { status: 'fail', message: 'robots.txt blocks search engine crawlers - this will prevent AdSense approval.' };
        }

        // Check for sitemap
        const hasSitemap = /sitemap:/i.test(text);
        if (hasSitemap) {
          return { status: 'pass', message: 'robots.txt configured correctly with sitemap reference.' };
        }

        return { status: 'pass', message: 'robots.txt allows crawling but consider adding sitemap reference.' };
      } catch (e) {
        return { status: 'warn', message: 'Could not analyze robots.txt due to network error.' };
      }
    })();

    checks.push({ name: 'Robots.txt Configuration', category: CAT_PERFORMANCE, weight: 12, ...robotsCheckResult });
    if (robotsCheckResult.status === 'pass') score += 12;
    else if (robotsCheckResult.status === 'warn') score += 6;

    // Enhanced navigation check
    runCheck('Navigation Structure', CAT_STRUCT_ACC, 10, () => {
      const nav = doc.querySelector('nav, header nav, .nav, .navigation, .menu');
      const navLinks = nav ? nav.querySelectorAll('a') : doc.querySelectorAll('header a, .menu a');

      if (navLinks.length >= 5) {
        return { status: 'pass', message: `Clear navigation with ${navLinks.length} links found.` };
      } else if (navLinks.length >= 3) {
        return { status: 'warn', message: `Navigation found with ${navLinks.length} links. Consider adding more sections.` };
      }
      return { status: 'fail', message: 'Insufficient navigation structure. Add clear menu with multiple sections.' };
    });

    // Enhanced privacy policy check
    runCheck('Privacy Policy Page', CAT_STRUCT_ACC, 25, () => {
      const privacyLink = findLink(['privacy', 'policy', 'privacy-policy']);
      if (privacyLink) {
        const href = privacyLink.href.toLowerCase();
        if (href.includes('privacy') || href.includes('policy')) {
          return { status: 'pass', message: 'Privacy Policy link found - REQUIRED for AdSense.' };
        }
      }
      return { status: 'fail', message: 'Privacy Policy page missing - CRITICAL REQUIREMENT for AdSense approval.' };
    });

    // Terms of Service check
    runCheck('Terms of Service/Use Page', CAT_STRUCT_ACC, 8, () => {
      const termsLink = findLink(['terms', 'service', 'use', 'tos', 'terms-of-service']);
      return termsLink
        ? { status: 'pass', message: 'Terms of Service page found.' }
        : { status: 'warn', message: 'Terms of Service page recommended for trust signals.' };
    });

    // Enhanced About/Contact check
    runCheck('About Us & Contact Information', CAT_STRUCT_ACC, 12, () => {
      const hasAbout = findLink(['about', 'about-us']);
      const hasContact = findLink(['contact', 'contact-us']);

      if (hasAbout && hasContact) {
        return { status: 'pass', message: 'Both About and Contact pages found.' };
      } else if (hasAbout || hasContact) {
        return { status: 'warn', message: `Missing ${hasAbout ? 'Contact' : 'About'} page. Both recommended.` };
      }
      return { status: 'fail', message: 'Both About and Contact pages missing - important for trust.' };
    });

    // Enhanced mobile responsiveness
    runCheck('Mobile Responsiveness', CAT_STRUCT_ACC, 10, () => {
      const viewport = doc.querySelector('meta[name="viewport"]');
      const hasResponsiveCss = Array.from(doc.querySelectorAll('style, link[rel="stylesheet"]'))
        .some(el => (el.textContent || el.href || '').includes('media'));

      if (viewport && viewport.content.includes('width=device-width')) {
        if (hasResponsiveCss) {
          return { status: 'pass', message: 'Mobile-optimized with viewport tag and responsive CSS.' };
        }
        return { status: 'warn', message: 'Viewport tag found but responsive CSS unclear.' };
      }
      return { status: 'fail', message: 'Missing viewport meta tag - essential for mobile users.' };
    });

    // Content quality indicators
    runCheck('Content Volume', CAT_CONTENT, 20, () => {
      const textContent = doc.body.textContent || '';
      const wordCount = textContent.split(/\s+/).filter(word => word.length > 2).length;

      if (wordCount > 1500) {
        return { status: 'pass', message: `Good content volume (~${wordCount} words).` };
      } else if (wordCount > 800) {
        return { status: 'warn', message: `Moderate content (~${wordCount} words). AdSense prefers sites with substantial content (1500+ words per page).` };
      } else if (wordCount > 300) {
        return { status: 'fail', message: `Low content volume (~${wordCount} words). AdSense requires substantial, valuable content.` };
      }
      return { status: 'fail', message: `Insufficient content (~${wordCount} words). AdSense typically rejects sites with minimal content.` };
    });

    // Heading structure
    runCheck('Heading Structure (SEO)', CAT_PERFORMANCE, 5, () => {
      const h1s = doc.querySelectorAll('h1');
      const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');

      if (h1s.length === 1 && headings.length >= 3) {
        return { status: 'pass', message: `Good heading structure: 1 H1, ${headings.length} total headings.` };
      } else if (h1s.length === 1) {
        return { status: 'warn', message: 'H1 found but consider adding more subheadings (H2, H3).' };
      } else if (h1s.length > 1) {
        return { status: 'warn', message: `Multiple H1 tags found (${h1s.length}). Use only one H1 per page.` };
      }
      return { status: 'fail', message: 'No H1 heading found. Add proper heading structure.' };
    });

    // Image optimization check
    runCheck('Image Optimization', CAT_PERFORMANCE, 4, () => {
      const images = doc.querySelectorAll('img');
      const imagesWithAlt = Array.from(images).filter(img => img.alt && img.alt.trim());

      if (images.length === 0) {
        return { status: 'warn', message: 'No images found. Visual content improves user engagement.' };
      }

      const altPercentage = (imagesWithAlt.length / images.length) * 100;
      if (altPercentage >= 80) {
        return { status: 'pass', message: `Good image accessibility: ${imagesWithAlt.length}/${images.length} images have alt text.` };
      } else if (altPercentage >= 50) {
        return { status: 'warn', message: `Some images missing alt text: ${imagesWithAlt.length}/${images.length}. Add for accessibility.` };
      }
      return { status: 'fail', message: `Poor image accessibility: only ${imagesWithAlt.length}/${images.length} images have alt text.` };
    });

    // Language declaration
    runCheck('Language Declaration', CAT_STRUCT_ACC, 3, () => {
      const lang = doc.documentElement.getAttribute('lang');
      return lang
        ? { status: 'pass', message: `Language declared as "${lang}".` }
        : { status: 'warn', message: 'No language declaration. Add lang attribute to <html> tag.' };
    });

    // Favicon check
    runCheck('Favicon Present', CAT_STRUCT_ACC, 2, () => {
      const favicon = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
      return favicon && favicon.href
        ? { status: 'pass', message: 'Favicon found - good for branding.' }
        : { status: 'warn', message: 'Favicon missing. Add for professional appearance.' };
    });

    // Performance indicator
    runCheck('Page Load Speed Indicator', CAT_PERFORMANCE, 3, () => {
      if (responseTime < 3000) {
        return { status: 'pass', message: `Good response time: ${responseTime}ms` };
      } else if (responseTime < 5000) {
        return { status: 'warn', message: `Moderate response time: ${responseTime}ms. Consider optimization.` };
      }
      return { status: 'fail', message: `Slow response time: ${responseTime}ms. Optimize for better user experience.` };
    });

    // Error page detection
    runCheck('Error Page Detection', CAT_STRUCT_ACC, 5, () => {
      const text = doc.body.textContent.toLowerCase();
      const errorIndicators = ['404', 'page not found', 'error', 'not found', 'does not exist'];
      const hasError = errorIndicators.some(indicator => text.includes(indicator));

      if (hasError) {
        return { status: 'fail', message: 'Potential error page or broken content detected.' };
      }
      return { status: 'pass', message: 'No obvious error indicators found.' };
    });

    // Social media presence
    runCheck('Social Media Integration', CAT_CONTENT, 3, () => {
      const socialLinks = Array.from(doc.querySelectorAll('a')).filter(link => {
        const href = link.href.toLowerCase();
        return ['facebook.com', 'twitter.com', 'instagram.com', 'linkedin.com', 'youtube.com']
          .some(platform => href.includes(platform));
      });

      if (socialLinks.length >= 2) {
        return { status: 'pass', message: `Social media links found (${socialLinks.length}). Good for trust signals.` };
      } else if (socialLinks.length === 1) {
        return { status: 'warn', message: 'Limited social media presence. Consider adding more platforms.' };
      }
      return { status: 'warn', message: 'No social media links found. Consider adding for trust signals.' };
    });

    // Google Analytics Check
    runCheck('Google Analytics Installed', CAT_PERFORMANCE, 7, () => {
      const scripts = Array.from(doc.querySelectorAll('script'));
      const hasAnalytics = scripts.some(script => {
        const src = script.src || '';
        const text = script.textContent || '';
        // Corrected line: Escaped single quote inside the string
        return src.includes('googletagmanager.com/gtag/js') || text.includes('ga-lite') || text.includes('ga(\'create\',');
      });
      if (hasAnalytics) {
        return { status: 'pass', message: 'Google Analytics script detected. This is a good sign of a well-managed site.' };
      }
      return { status: 'warn', message: 'Google Analytics script not found. Tracking site traffic is highly recommended.' };
    });

    // ads.txt Check
    const adsTxtCheckResult = await (async () => {
      try {
        const origin = new URL(finalResolvedUrl).origin;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const adsTxtRes = await fetch(`${origin}/ads.txt`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AdSense-Analyzer-Bot/1.0' }
        });

        clearTimeout(timeoutId);

        if (!adsTxtRes.ok) {
          return { status: 'warn', message: 'ads.txt file not found. This is recommended for all publishers.' };
        }

        const text = await adsTxtRes.text();

        if (text.includes('google.com, pub-')) {
          return { status: 'pass', message: 'ads.txt file found and seems to contain a Google publisher ID.' };
        }

        return { status: 'warn', message: 'ads.txt file found, but it does not appear to contain a Google publisher ID.' };
      } catch (e) {
        return { status: 'warn', message: 'Could not analyze ads.txt due to a network error.' };
      }
    })();

    checks.push({ name: 'Ads.txt Presence', category: CAT_AUTO, weight: 10, ...adsTxtCheckResult });
    if (adsTxtCheckResult.status === 'pass') score += 10;
    else if (adsTxtCheckResult.status === 'warn') score += 5;

    // Structured Data Check
    runCheck('Structured Data (Schema.org)', CAT_PERFORMANCE, 6, () => {
      const structuredData = doc.querySelector('script[type="application/ld+json"]');
      if (structuredData) {
        return { status: 'pass', message: 'Structured data (JSON-LD) found. This helps search engines understand your content.' };
      }
      return { status: 'warn', message: 'No structured data (JSON-LD) found. Consider adding it to improve SEO.' };
    });

    // Main Content Volume Analysis
    runCheck('Main Content Volume', CAT_CONTENT, 15, () => {
      let mainContentEl = doc.querySelector('article, main, .main, .post, #content');
      if (!mainContentEl) {
        mainContentEl = doc.body;
      }
      const textContent = mainContentEl.textContent || '';
      const wordCount = textContent.split(/\s+/).filter(word => word.length > 2).length;

      if (wordCount > 1000) {
        return { status: 'pass', message: `Excellent main content volume (~${wordCount} words).` };
      } else if (wordCount > 500) {
        return { status: 'warn', message: `Sufficient main content (~${wordCount} words), but more is better for AdSense.` };
      }
      return { status: 'fail', message: `Low main content volume (~${wordCount} words). This is a major red flag for AdSense.` };
    });

    // Manual checks
    checks.push({
      name: 'Content Originality & Quality',
      category: CAT_CONTENT,
      status: 'manual',
      message: 'Ensure all content is original, well-written, and provides value to users. No copied content allowed.'
    });

    checks.push({
      name: 'Content Policy Compliance',
      category: CAT_CONTENT,
      status: 'manual',
      message: 'Verify content complies with AdSense policies: no adult content, violence, illegal activities, etc.'
    });

    checks.push({
      name: 'User Experience & Site Design',
      category: CAT_CONTENT,
      status: 'manual',
      message: 'Ensure professional design, easy navigation, fast loading, and good user experience.'
    });

    // Calculate total possible weight from automated checks only
    const automatedChecks = checks.filter(check => check.status !== 'manual');
    const totalPossibleWeight = automatedChecks.reduce((sum, check) => sum + check.weight, 0);

    // Calculate percentage score (0-100)
    let finalScore = totalPossibleWeight > 0 ? Math.round((score / totalPossibleWeight) * 100) : 0;
    let penalties = [];

    // Critical failures that severely impact AdSense approval
    const criticalChecks = checks.filter(check =>
      check.status === 'fail' &&
      (check.name.includes('Privacy Policy') ||
       check.name.includes('HTTPS') ||
       check.name.includes('Content Volume') ||
       check.name.includes('robots.txt'))
    );

    if (criticalChecks.length > 0) {
      const penalty = criticalChecks.length * 15;
      finalScore = Math.max(0, finalScore - penalty);
      penalties.push(`Critical issues detected: -${penalty}%`);
    }

    // Additional penalty for sites with multiple failures
    const failedChecks = checks.filter(check => check.status === 'fail').length;
    if (failedChecks > 5) {
      const penalty = (failedChecks - 5) * 3;
      finalScore = Math.max(0, finalScore - penalty);
      penalties.push(`Multiple failures: -${penalty}%`);
    }

    // Cap score at 65% if any critical requirements are missing
    if (criticalChecks.length > 0) {
      finalScore = Math.min(finalScore, 65);
    }

    // Ensure score never exceeds 100
    finalScore = Math.min(finalScore, 100);

    // Realistic scoring brackets
    let scoreInterpretation;
    if (finalScore >= 80) {
      scoreInterpretation = "Good technical foundation, but AdSense approval depends heavily on content quality, originality, and policy compliance.";
    } else if (finalScore >= 60) {
      scoreInterpretation = "Some technical issues need attention. Address critical requirements before applying to AdSense.";
    } else {
      scoreInterpretation = "Significant technical issues detected. Your site likely needs substantial improvements before AdSense consideration.";
    }

    res.json({
      score: finalScore,
      checks,
      finalResolvedUrl,
      analysisTime: Date.now() - (Date.now() - responseTime),
      penalties,
      scoreInterpretation,
      recommendations: finalScore < 60 ? [
        'Fix ALL critical issues immediately (HTTPS, Privacy Policy, Content Volume)',
        'Add substantial, original, high-quality content (minimum 1500+ words per page)',
        'Ensure complete site structure with all required legal pages',
        'AdSense approval requires months of consistent, valuable content creation'
      ] : finalScore < 80 ? [
        'Address remaining technical issues',
        'Focus heavily on content quality and originality',
        'Ensure full compliance with AdSense content policies',
        'Build substantial site authority before applying'
      ] : [
        'Technical foundation is decent, but remember:',
        'AdSense approval is primarily about content quality and originality',
        'Ensure compliance with all AdSense content policies',
        'Traffic volume and site authority are also crucial factors'
      ]
    });

  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({
      error: `Analysis failed: ${error.message}`,
      details: 'Please check that the website is accessible and contains valid HTML content.'
    });
  }
});

// Function to add watermark to HTML content
const addWatermark = (htmlContent, logoUrl) => {
  // Wrap the provided HTML content in a full HTML document structure.
  // All necessary styles are expected to be inlined in htmlContent.
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Adranalyzer Report</title>
      <style>
        /* Basic watermark styling */
        .watermark {
          position: fixed;
          bottom: 20px;
          right: 20px;
          opacity: 0.6;
          z-index: 9999;
          pointer-events: none;
        }
        .watermark img {
          width: 150px;
          height: auto;
        }
      </style>
    </head>
    <body>
      ${htmlContent}
      <div class="watermark">
        <img src="${logoUrl}" alt="Adranalyzer Logo"/>
      </div>
    </body>
    </html>
  `;
};

// New endpoint for image download
app.post('/api/download-image', async (req, res) => {
  const { htmlContent, logoUrl } = req.body;

  if (!htmlContent || !logoUrl) {
    return res.status(400).json({ error: 'HTML content and logo URL are required.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Set content and wait for network idle to ensure all resources are loaded
    await page.setContent(addWatermark(htmlContent, logoUrl), { waitUntil: 'networkidle0' });

    // Set a reasonable viewport size for the screenshot
    await page.setViewport({ width: 1200, height: 800 });

    const screenshotBuffer = await page.screenshot({ fullPage: true });

    res.setHeader('Content-Disposition', 'attachment; filename="adranalyzer-report.png"');
    res.setHeader('Content-Type', 'image/png');
    res.send(screenshotBuffer);
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ error: `Failed to generate image: ${error.message || error}` });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// New endpoint for PDF download
app.post('/api/download-pdf', async (req, res) => {
  const { htmlContent, logoUrl } = req.body;

  if (!htmlContent || !logoUrl) {
    return res.status(400).json({ error: 'HTML content and logo URL are required.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Set content and wait for network idle to ensure all resources are loaded
    await page.setContent(addWatermark(htmlContent, logoUrl), { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '20mm',
        bottom: '20mm',
        left: '20mm'
      }
    });

    res.setHeader('Content-Disposition', 'attachment; filename="adranalyzer-report.pdf"');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: `Failed to generate PDF: ${error.message || error}` });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AdSense Readiness Analyzer running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Enhanced with ${15} automated checks + manual guidance`);
});
