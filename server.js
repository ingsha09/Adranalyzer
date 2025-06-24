
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

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
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
    runCheck('Secure Connection (HTTPS/SSL)', CAT_AUTO, 15, () => {
      if (finalResolvedUrl.startsWith('https://')) {
        return { status: 'pass', message: 'Site uses HTTPS encryption.' };
      } else {
        return { status: 'fail', message: 'Site does not use HTTPS. This is critical for AdSense approval.' };
      }
    });

    // HTTPS redirect check
    runCheck('HTTPS Redirect Check', CAT_AUTO, 10, () => {
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
    runCheck('Privacy Policy Page', CAT_STRUCT_ACC, 15, () => {
      const privacyLink = findLink(['privacy', 'policy', 'privacy-policy']);
      if (privacyLink) {
        const href = privacyLink.href.toLowerCase();
        if (href.includes('privacy') || href.includes('policy')) {
          return { status: 'pass', message: 'Privacy Policy link found - required for AdSense.' };
        }
      }
      return { status: 'fail', message: 'Privacy Policy page missing - REQUIRED for AdSense approval.' };
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
    runCheck('Content Volume', CAT_CONTENT, 8, () => {
      const textContent = doc.body.textContent || '';
      const wordCount = textContent.split(/\s+/).filter(word => word.length > 2).length;
      
      if (wordCount > 500) {
        return { status: 'pass', message: `Substantial content detected (~${wordCount} words).` };
      } else if (wordCount > 200) {
        return { status: 'warn', message: `Moderate content (~${wordCount} words). Consider adding more quality content.` };
      }
      return { status: 'fail', message: `Low content volume (~${wordCount} words). AdSense requires substantial content.` };
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

    const finalScore = Math.min(100, Math.round(score));
    
    res.json({ 
      score: finalScore, 
      checks, 
      finalResolvedUrl,
      analysisTime: Date.now() - (Date.now() - responseTime),
      recommendations: finalScore < 70 ? [
        'Focus on fixing critical issues (HTTPS, Privacy Policy, robots.txt)',
        'Add more quality content with proper structure',
        'Ensure mobile responsiveness and fast loading',
        'Complete all required pages (About, Contact, Terms)'
      ] : [
        'Your site shows good technical foundation',
        'Review manual checks carefully',
        'Consider additional content and social presence',
        'Monitor site performance regularly'
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AdSense Readiness Analyzer running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Enhanced with ${15} automated checks + manual guidance`);
});
