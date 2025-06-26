// server.js

import express from 'express';
import fetch from 'node-fetch'; // Assumes you're using node-fetch for fetch, if not, adjust
import { JSDOM } from 'jsdom';
import cors from 'cors'; // Import the cors module
import OpenAI from 'openai'; // Import the OpenAI SDK

// Load environment variables if using .env for local development
// For Render, these are automatically available from environment variables
// If you're running locally with a .env file, uncomment the line below:
// import dotenv from 'dotenv';
// dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize the OpenAI client for DeepSeek AI
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com/v1', // DeepSeek's base URL for v1 API
  apiKey: process.env.DEEPSEEK_API_KEY // Securely access API key from environment variables
});

// Define your allowed origins for CORS
const allowedOrigins = [
  'https://adranalyzer.blogspot.com',       // Your Blogger domain
  'https://www.adranalyzer.blogspot.com',   // Your Blogger domain (www version)
  'http://localhost:8080',                  // For local development
  'http://127.0.0.1:5500',                  // For local development (e.g., Live Server)
  'https://adranalyzer.onrender.com'        // Your deployed Render app's domain (if it makes internal calls or for testing)
];

// Configure CORS middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g., from Postman, curl, or direct server-to-server calls)
    if (!origin) {
      return callback(null, true);
    }

    // Check if the request's origin is in our allowedOrigins list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // If the origin is not allowed, reject the request
    callback(new Error(`CORS policy does not allow access from: ${origin}`), false);
  },
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // Explicitly allow common HTTP methods
  credentials: true, // Allow cookies to be sent (if your app uses them)
  optionsSuccessStatus: 204 // Use 204 for preflight success (standard practice)
}));

// Middleware to parse JSON request bodies
app.use(express.json());

// --- REMOVED STATIC FILE SERVING FOR FRONTEND ---
// These lines are removed because Blogger will now serve your index.html.
// app.use(express.static('public'));
// app.get('/', (req, res) => {
//   res.sendFile('index.html', { root: 'public' });
// });

// Health check endpoint (useful for Render to know your app is alive)
app.get('/health', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send("Hello from your Node.js backend! I'm alive!\n");
});

// --- Start of your `fetchWithRedirects` function ---
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
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second timeout

      response = await fetch(finalUrl, {
        ...defaultOptions,
        redirect: 'manual', // Manually handle redirects
        signal: controller.signal // Apply abort signal for timeout
      });

      clearTimeout(timeoutId); // Clear timeout if request completes before timeout

      // Handle redirects (3xx status codes)
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        const location = response.headers.get('location');
        finalUrl = new URL(location, finalUrl).href; // Resolve relative redirects
        console.log(`Redirecting to: ${finalUrl}`);
      } else {
        break; // Not a redirect, or no location header, or outside 3xx range, so break loop
      }
    } catch (error) {
      console.error(`Fetch error at ${finalUrl}:`, error.message);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout - website took too long to respond');
      }
      throw error; // Re-throw other errors
    }
  }

  // After handling redirects, make the final request to the resolved URL
  return fetch(finalUrl, defaultOptions);
}
// --- End of your `fetchWithRedirects` function ---


// Main API endpoint for URL analysis
app.post('/api/analyze-url', async (req, res) => {
  const { url: initialUrl } = req.body;

  if (!initialUrl) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  // Enhanced URL validation and HTTPS fallback
  let targetUrl = initialUrl.trim();
  if (!targetUrl.match(/^https?:\/\//)) {
    targetUrl = `https://${targetUrl}`; // Default to HTTPS if no protocol specified
  }

  try {
    new URL(targetUrl); // Validate URL format
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL format provided.' });
  }

  let checks = [];
  let score = 0;
  let doc;
  let finalResolvedUrl;
  let responseTime = Date.now(); // Start timer for response time
  let recommendations = []; // Initialize recommendations array

  try {
    let htmlResponse;

    try {
      htmlResponse = await fetchWithRedirects(targetUrl);
      responseTime = Date.now() - responseTime; // Calculate response time

      // If initial HTTPS fails, try HTTP (less secure, but sometimes necessary)
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
      console.error('Fetch error during initial access:', error);
      return res.status(500).json({
        error: `Failed to access website: ${error.message}. Please check if the URL is correct and the website is accessible.`
      });
    }

    finalResolvedUrl = htmlResponse.url; // Get the final URL after redirects
    const contentType = htmlResponse.headers.get('content-type') || '';

    // Check if the content type is HTML
    if (!contentType.includes('text/html')) {
      return res.status(400).json({
        error: 'The URL does not point to an HTML webpage. Please provide a valid website URL.'
      });
    }

    const html = await htmlResponse.text(); // Get the HTML content

    // Basic check for empty or minimal content
    if (!html || html.length < 100) {
      return res.status(400).json({
        error: 'Website returned empty or minimal content. Please check if the URL is correct.'
      });
    }

    // Parse HTML using JSDOM
    try {
      const dom = new JSDOM(html);
      doc = dom.window.document;
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to parse website HTML. The website may have malformed content.'
      });
    }

    // --- DEEPSEEK AI INTEGRATION START ---
    let aiFeedback = {};
    // Limit content length for API to avoid hitting token limits and for cost efficiency
    // DeepSeek-chat model has 64K context window, but keeping it concise for efficiency.
    const contentForAI = doc.body.textContent.slice(0, 15000);
    const pageTitle = doc.querySelector('title')?.textContent?.trim();
    const metaDescription = doc.querySelector('meta[name="description"]')?.content?.trim();

    try {
      const deepseekCompletion = await openai.chat.completions.create({
        model: "deepseek-chat", // Using the general chat model for analysis
        messages: [
          {
            role: 'system',
            content: 'You are an expert AI assistant specializing in Google AdSense policy and website quality analysis. Your goal is to provide concise, actionable feedback for AdSense approval based on the provided website content, focusing on content quality, originality, policy compliance, and user experience readiness. Provide specific, constructive suggestions.'
          },
          {
            role: 'user',
            content: `Analyze the following website content for Google AdSense readiness.

              Page Title: "${pageTitle || 'Not available'}"
              Meta Description: "${metaDescription || 'Not available'}"

              Content Excerpt:
              ${contentForAI}

              Please provide your analysis and recommendations in a structured JSON format with the following keys:
              - "content_quality_review": A brief assessment of content originality, depth, and value.
              - "policy_compliance_concerns": Any potential AdSense policy violations (e.g., restricted content, low value, spam).
              - "readability_usability_suggestions": Recommendations for improving text readability and overall user experience.
              - "overall_ad_readiness_summary": A concise summary of the site's AdSense readiness and top priorities.
              `
          }
        ],
        temperature: 0.7, // Adjust for creativity (higher) or consistency (lower)
        max_tokens: 1200, // Max tokens for AI's response
        response_format: { type: "json_object" } // Request JSON output explicitly
      });

      // Parse the AI's response
      const aiRawContent = deepseekCompletion.choices[0].message.content;
      try {
        aiFeedback = JSON.parse(aiRawContent);
      } catch (jsonParseError) {
        console.error('Failed to parse AI JSON response:', jsonParseError, 'Raw AI content:', aiRawContent);
        aiFeedback.error = `AI analysis returned malformed JSON: ${aiRawContent.slice(0, 200)}...`;
      }

    } catch (aiError) {
      console.error('Error calling DeepSeek API:', aiError);
      aiFeedback.error = `Error during AI analysis: ${aiError.message}`;
    }
    // --- DEEPSEEK AI INTEGRATION END ---


    // --- Start of AdSense-specific checks and scoring logic ---
    const CAT_AUTO = 'Automated Technical Checks';
    const CAT_STRUCT_ACC = 'Site Structure & Accessibility';
    const CAT_CONTENT = 'Content Quality Indicators';
    const CAT_PERFORMANCE = 'Performance & SEO';

    // Helper function to run a check and record its result
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

    // Helper to find links by keywords
    const findLink = (keywords, contextDoc = doc) =>
      Array.from(contextDoc.querySelectorAll('a')).find(link => {
        const href = (link.href || '').toLowerCase();
        const text = (link.textContent || '').toLowerCase();
        return keywords.some(keyword => href.includes(keyword) || text.includes(keyword));
      });

    // Automated Technical Checks
    runCheck('Secure Connection (HTTPS/SSL)', CAT_AUTO, 20, () => {
      if (finalResolvedUrl.startsWith('https://')) {
        return { status: 'pass', message: 'Site uses HTTPS encryption.' };
      } else {
        return { status: 'fail', message: 'Site does not use HTTPS. This is CRITICAL for AdSense approval.' };
      }
    });

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

    // SEO & Performance Checks
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

    // Enhanced robots.txt check (async function within runCheck)
    const robotsCheckResult = await (async () => {
      try {
        const origin = new URL(finalResolvedUrl).origin;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second timeout for robots.txt

        const robotsRes = await fetch(`${origin}/robots.txt`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AdSense-Analyzer-Bot/1.0' } // Custom User-Agent
        });

        clearTimeout(timeoutId);

        if (!robotsRes.ok) {
          // 404 or other non-OK status for robots.txt
          return { status: 'warn', message: 'robots.txt not found. Consider adding one for better SEO.' };
        }

        const text = await robotsRes.text();

        // Check for common blocking patterns
        const blockingPatterns = [
          /User-agent:\s*\*\s*Disallow:\s*\/$/im,
          /User-agent:\s*Googlebot\s*Disallow:\s*\/$/im,
          /User-agent:\s*AdsBot-Google\s*Disallow:\s*\/$/im
        ];

        const isBlocked = blockingPatterns.some(pattern => pattern.test(text));

        if (isBlocked) {
          return { status: 'fail', message: 'robots.txt blocks search engine crawlers - this will prevent AdSense approval.' };
        }

        // Check for sitemap reference
        const hasSitemap = /sitemap:/i.test(text);
        if (hasSitemap) {
          return { status: 'pass', message: 'robots.txt configured correctly with sitemap reference.' };
        }

        return { status: 'pass', message: 'robots.txt allows crawling but consider adding sitemap reference.' };
      } catch (e) {
        // Handle network errors or timeouts for robots.txt fetch
        return { status: 'warn', message: `Could not analyze robots.txt due to network error: ${e.message}` };
      }
    })();

    checks.push({ name: 'Robots.txt Configuration', category: CAT_PERFORMANCE, weight: 12, ...robotsCheckResult });
    if (robotsCheckResult.status === 'pass') score += 12;
    else if (robotsCheckResult.status === 'warn') score += 6;


    // Site Structure & Accessibility
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

    runCheck('Terms of Service/Use Page', CAT_STRUCT_ACC, 8, () => {
      const termsLink = findLink(['terms', 'service', 'use', 'tos', 'terms-of-service']);
      return termsLink
        ? { status: 'pass', message: 'Terms of Service page found.' }
        : { status: 'warn', message: 'Terms of Service page recommended for trust signals.' };
    });

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

    // Content Quality Indicators
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

    runCheck('Language Declaration', CAT_STRUCT_ACC, 3, () => {
      const lang = doc.documentElement.getAttribute('lang');
      return lang
        ? { status: 'pass', message: `Language declared as "${lang}".` }
        : { status: 'warn', message: 'No language declaration. Add lang attribute to <html> tag.' };
    });

    runCheck('Favicon Present', CAT_STRUCT_ACC, 2, () => {
      const favicon = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
      return favicon && favicon.href
        ? { status: 'pass', message: 'Favicon found - good for branding.' }
        : { status: 'warn', message: 'Favicon missing. Add for professional appearance.' };
    });

    runCheck('Page Load Speed Indicator', CAT_PERFORMANCE, 3, () => {
      if (responseTime < 3000) {
        return { status: 'pass', message: `Good response time: ${responseTime}ms` };
      } else if (responseTime < 5000) {
        return { status: 'warn', message: `Moderate response time: ${responseTime}ms. Consider optimization.` };
      }
      return { status: 'fail', message: `Slow response time: ${responseTime}ms. Optimize for better user experience.` };
    });

    runCheck('Error Page Detection', CAT_STRUCT_ACC, 5, () => {
      const text = doc.body.textContent.toLowerCase();
      const errorIndicators = ['404', 'page not found', 'error', 'not found', 'does not exist'];
      const hasError = errorIndicators.some(indicator => text.includes(indicator));

      if (hasError) {
        return { status: 'fail', message: 'Potential error page or broken content detected.' };
      }
      return { status: 'pass', message: 'No obvious error indicators found.' };
    });

    runCheck('Social Media Integration', CAT_CONTENT, 3, () => {
      const socialLinks = Array.from(doc.querySelectorAll('a')).filter(link => {
        const href = link.href.toLowerCase();
        // Updated platform checks, removed a problematic YouTube pattern
        return ['facebook.com', 'twitter.com', 'instagram.com', 'linkedin.com']
          .some(platform => href.includes(platform));
      });

      if (socialLinks.length >= 2) {
        return { status: 'pass', message: `Social media links found (${socialLinks.length}). Good for trust signals.` };
      } else if (socialLinks.length === 1) {
        return { status: 'warn', message: 'Limited social media presence. Consider adding more platforms.' };
      }
      return { status: 'warn', message: 'No social media links found. Consider adding for trust signals.' };
    });

    // Manual checks - these are just for display, don't affect automated score
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
      const penalty = criticalChecks.length * 15; // Example penalty
      finalScore = Math.max(0, finalScore - penalty);
      penalties.push(`Critical issues detected: -${penalty}%`);
    }

    // Additional penalty for sites with multiple failures
    const failedChecks = checks.filter(check => check.status === 'fail').length;
    if (failedChecks > 5) {
      const penalty = (failedChecks - 5) * 3; // Example penalty for many failures
      finalScore = Math.max(0, finalScore - penalty);
      penalties.push(`Multiple failures: -${penalty}%`);
    }

    // Cap score at 65% if any critical requirements are missing (AdSense is strict)
    if (criticalChecks.length > 0) {
      finalScore = Math.min(finalScore, 65);
    }

    // Ensure score never exceeds 100
    finalScore = Math.min(finalScore, 100);

    // Interpret the final score
    let scoreInterpretation;
    if (finalScore >= 80) {
      scoreInterpretation = "Good technical foundation, but AdSense approval depends heavily on content quality, originality, and policy compliance.";
    } else if (finalScore >= 60) {
      scoreInterpretation = "Some technical issues need attention. Address critical requirements before applying to AdSense.";
    } else {
      scoreInterpretation = "Significant technical issues detected. Your site likely needs substantial improvements before AdSense consideration.";
    }

    // Recommendations based on score (original recommendations are preserved here)
    const initialRecommendations = finalScore < 60 ? [
      'Fix ALL critical issues immediately (HTTPS, Privacy Policy, Content Volume, robots.txt)',
      'Add substantial, original, high-quality content (minimum 1500+ words per page on key pages)',
      'Ensure complete site structure with all required legal and informational pages (About Us, Contact Us, Privacy Policy, Terms of Service)',
      'AdSense approval often requires months of consistent, valuable content creation and site development.'
    ] : finalScore < 80 ? [
      'Address any remaining technical issues identified.',
      'Focus heavily on content quality, originality, and providing unique value to users.',
      'Ensure full compliance with all AdSense content policies (no prohibited content).',
      'Build substantial site authority and user engagement before applying.'
    ] : [
      'Your site has a decent technical foundation, but remember:',
      'AdSense approval is primarily about the quality, originality, and value of your content.',
      'Ensure compliance with all AdSense content policies.',
      'User experience, site design, and traffic volume are also crucial factors that AdSense considers.'
    ];

    // Combine original recommendations with AI-generated ones
    recommendations.push(...initialRecommendations);

    // Integrate AI feedback into the final response (as checks or specific recommendations)
    if (aiFeedback.content_quality_review) {
        checks.push({
            name: 'AI Content Quality Review',
            category: CAT_CONTENT,
            status: aiFeedback.policy_compliance_concerns ? 'fail' : 'manual', // If AI finds policy concerns, flag as fail/manual
            message: `**AI Feedback:** ${aiFeedback.content_quality_review}`
        });
    }
    if (aiFeedback.policy_compliance_concerns) {
         checks.push({
            name: 'AI Policy Compliance Check',
            category: 'Policies',
            status: 'fail', // AI-identified policy concerns should be a strong warning
            message: `**AI Identified Policy Concerns:** ${aiFeedback.policy_compliance_concerns}`
        });
    }
    if (aiFeedback.readability_usability_suggestions) {
        recommendations.push(`**AI Readability & Usability:** ${aiFeedback.readability_usability_suggestions}`);
    }
    if (aiFeedback.overall_ad_readiness_summary) {
        recommendations.push(`**AI Overall Summary:** ${aiFeedback.overall_ad_readiness_summary}`);
    }
    if (aiFeedback.error) {
        recommendations.push(`**AI Analysis Error:** ${aiFeedback.error}`);
    }


    res.json({
      score: finalScore,
      checks,
      finalResolvedUrl,
      analysisTime: responseTime, // Use the calculated response time
      penalties,
      scoreInterpretation,
      recommendations, // This now includes AI recommendations
      aiAnalysis: aiFeedback // Send the raw AI feedback to frontend for more detailed display
    });

  } catch (error) {
    console.error("Analysis error in /api/analyze-url:", error); // Specific logging
    res.status(500).json({
      error: `Analysis failed: ${error.message}`,
      details: 'Please check that the website is accessible and contains valid HTML content. The server might also be too slow or blocking access.'
    });
  }
});

// Start the server
// Listen on '0.0.0.0' for Render deployments
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AdSense Readiness Analyzer running on http://0.0.0.0:${PORT}`);
  // Updated message to reflect AI integration
  console.log(`📊 Enhanced with automated checks, manual guidance, and DeepSeek AI analysis.`);
});
