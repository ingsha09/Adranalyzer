//server

const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const cors = require('cors'); 

const app = express();
const PORT = process.env.PORT || 3000; 

// Configure CORS to allow requests from your Blogger blog AND your Replit frontend
const allowedOrigins = [
    'https://aranalyzer.blogspot.com', 
    'https://www.aranalyzer.blogspot.com',
    process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : null,
    'http://localhost:8080', 
    'http://127.0.0.1:5500' 
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
            callback(new Error(msg), false);
        }
    }
}));

app.use(express.json()); 



// Helper function to fetch URL and follow redirects accurately
async function fetchWithRedirects(url, options = {}, maxRedirects = 5) {
    let finalUrl = url;
    let response;

    for (let i = 0; i < maxRedirects; i++) {
        try {
            // Set a generous timeout for external website fetches
            response = await fetch(finalUrl, { ...options, redirect: 'manual', timeout: 25000 }); // Increased timeout
            if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
                const location = response.headers.get('location');
                finalUrl = new URL(location, finalUrl).href; 
                console.log(`Redirecting to: ${finalUrl}`);
            } else {
                break; 
            }
        } catch (error) {
            console.error(`Fetch error at ${finalUrl} (redirect attempt ${i + 1}):`, error.message);
            throw error; 
        }
    }
    return fetch(finalUrl, options); 
}

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
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`; 
        }

        let htmlResponse;
        try {
            htmlResponse = await fetchWithRedirects(targetUrl, { timeout: 25000 }); 
            if (!htmlResponse.ok) {
                if (targetUrl.startsWith('https://')) {
                    console.warn(`HTTPS fetch failed for ${targetUrl} (Status: ${htmlResponse.status || 'No Response'}). Trying HTTP...`);
                    targetUrl = targetUrl.replace('https://', 'http://');
                    htmlResponse = await fetchWithRedirects(targetUrl, { timeout: 25000 });
                }
            }
            if (!htmlResponse.ok) {
                throw new Error(`Server responded with status: ${htmlResponse.status}.`);
            }
        } catch (error) {
            console.error(`Initial content fetch error for ${targetUrl}:`, error);
            if (error.name === 'AbortError') {
                return res.status(504).json({ error: 'Request timed out. The target server might be too slow or blocking requests.' });
            }
            if (error.code === 'ENOTFOUND') {
                return res.status(400).json({ error: 'Could not resolve hostname. Please check the URL for typos.' });
            }
            if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
                return res.status(502).json({ error: 'Connection refused. The server might be offline or blocking connections.' });
            }
            return res.status(500).json({ error: `Failed to fetch website content: ${error.message}. Verify the URL and site accessibility.` });
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
            if (result.status === 'pass') {
                score += weight;
            } else if (result.status === 'warn') {
                score += weight / 2;
            }
        };

        const findLink = (keywords, contextDoc = doc) => Array.from(contextDoc.querySelectorAll('a')).find(link => {
            const href = link.href.toLowerCase();
            const text = link.textContent.toLowerCase();
            return keywords.some(keyword => href.includes(keyword) || text.includes(keyword));
        });

        // --- Automated Technical Checks ---

        runCheck('Secure Connection (HTTPS/SSL)', CAT_AUTO, 15, () => {
            if (finalResolvedUrl.startsWith('https://')) {
                return { status: 'pass', message: 'Site is served over HTTPS (secure connection).' };
            }
            return { status: 'fail', message: `Site did not load over HTTPS (${finalResolvedUrl}). SSL is mandatory for modern web and AdSense. Verify your site redirects to HTTPS correctly.` };
        });

        runCheck('HTTPS Redirect Check', CAT_AUTO, 10, () => {
            const initialUrlObj = new URL(initialUrl.startsWith('http') ? initialUrl : `https://${initialUrl}`);
            const finalUrlObj = new URL(finalResolvedUrl);

            if (initialUrlObj.protocol === 'http:' && finalUrlObj.protocol === 'https:' && initialUrlObj.hostname === finalUrlObj.hostname) {
                return { status: 'pass', message: 'HTTP requests are correctly redirecting to HTTPS.' };
            } else if (initialUrlObj.protocol === 'https:' && finalUrlObj.protocol === 'https:' && initialUrlObj.hostname === finalUrlObj.hostname) {
                return { status: 'pass', message: 'Site loaded directly via HTTPS (no HTTP redirect from HTTP detected). This is good.' };
            }
            return { status: 'warn', message: `Could not verify HTTP to HTTPS redirect for ${initialUrl}. Ensure all HTTP traffic redirects cleanly to HTTPS.` };
        });

        runCheck('Sufficient Content Volume', CAT_AUTO, 20, () => {
            const mainContentEl = doc.querySelector('main, article, .post-body, #main-content, #content, [role="main"]');
            const contentSource = mainContentEl || doc.body; 
            const wordCount = contentSource.textContent.split(/\s+/).filter(Boolean).length;
            const sourceMsg = mainContentEl ? "in main content area" : "on entire page (no specific content area found)";

            if (wordCount > 500) return { status: 'pass', message: `Good content volume detected (approx. ${wordCount} words ${sourceMsg}).` };
            if (wordCount > 200) return { status: 'warn', message: `Content volume is somewhat low (approx. ${wordCount} words ${sourceMsg}). Aim for more substantive content (500+ words recommended for informational pages).` };
            return { status: 'fail', message: `Very low content volume detected (approx. ${wordCount} words ${sourceMsg}). AdSense requires substantial, original content. (Note: Dynamic content loaded by JS after initial page load won't be counted).` };
        });

        runCheck('Descriptive Title Tag', CAT_AUTO, 5, () => {
            const title = doc.querySelector('title')?.textContent.trim();
            return title && title.length >= 15 && title.length <= 60 ?
                { status: 'pass', message: `A descriptive title tag was found: "${title}".` } :
                { status: 'fail', message: `Title tag is missing, too short (length: ${title?.length || 0}), or too long. Current: "${title || 'N/A'}". Aim for 15-60 characters.` };
        });

        // Robots.txt Configuration (Async on server)
        const robotsCheckResult = await (async () => {
            try {
                const origin = new URL(finalResolvedUrl).origin;
                const robotsRes = await fetch(`${origin}/robots.txt`, { timeout: 5000 }); 

                if (!robotsRes.ok) {
                     if (robotsRes.status === 404) {
                         return { status: 'warn', message: 'No robots.txt file found. While not always critical, it\'s good practice for search engine control.' };
                     }
                    return { status: 'fail', message: `Could not fetch robots.txt (Status: ${robotsRes.status}). This may indicate a problem. Verify your robots.txt is accessible to Googlebot.` };
                }
                const text = await robotsRes.text();
                const googlebotBlocked = /User-agent:.*(Googlebot|AdsBot-Google|*)\s*Disallow:\s*\/$/im.test(text);
                if (googlebotBlocked) {
                    return { status: 'fail', message: 'Your robots.txt file appears to block all access to Googlebot/AdsBot. This is a critical issue for AdSense. Review its content carefully.' };
                }
                return { status: 'pass', message: 'robots.txt exists and does not appear to block Google/AdsBot.' };
            } catch (e) {
                let msg = 'Could not fetch or analyze robots.txt file.';
                 if (e.name === 'AbortError') msg = 'Fetching robots.txt timed out.';
                return { status: 'fail', message: msg + ' This may indicate the file is inaccessible. Verify your robots.txt is directly accessible to Googlebot.' };
            }
        })();
        checks.push({ name: 'Robots.txt Configuration', category: CAT_AUTO, weight: 10, ...robotsCheckResult });
        if (robotsCheckResult.status === 'pass') score += 10;
        else if (robotsCheckResult.status === 'warn') score += 5;


        // --- Site Structure & Accessibility ---

        runCheck('Clear Navigation Menu', CAT_STRUCT_ACC, 8, () => {
            const nav = doc.querySelector('nav');
            if (nav && nav.querySelectorAll('a').length >= 3) {
                return { status: 'pass', message: 'A primary navigation menu (<nav> tag with sufficient links) was found.' };
            }
            return { status: 'fail', message: 'No clear navigation menu found or it has too few links. A site must be easy to navigate for users and bots.' };
        });

        runCheck('Privacy Policy Page', CAT_STRUCT_ACC, 12, () => {
            return findLink(['privacy', 'policy', 'privacy-policy', 'terms']) ?
                { status: 'pass', message: 'A Privacy Policy link was found. This is mandatory for AdSense.' } :
                { status: 'fail', message: 'A Privacy Policy link could not be found. This is a critical requirement for AdSense.' };
        });

        runCheck('About Us & Contact Pages', CAT_STRUCT_ACC, 10, () => {
            const hasAbout = findLink(['about', 'who-we-are', 'our-story']);
            const hasContact = findLink(['contact', 'contact-us', 'reach-us']);
            if (hasAbout && hasContact) {
                return { status: 'pass', message: 'About Us and Contact Us page links were found.' };
            } else if (hasAbout || hasContact) {
                return { status: 'warn', message: `Missing ${hasAbout ? 'Contact Us' : 'About Us'} page link. These pages build trust and transparency.` };
            }
            return { status: 'fail', message: 'Neither an About Us nor a Contact Us page link could be found. Critical for trustworthiness.' };
        });

        runCheck('Mobile Responsiveness (Viewport Meta Tag)', CAT_STRUCT_ACC, 8, () => {
            const viewportMeta = doc.querySelector('meta[name="viewport"]');
            if (viewportMeta && viewportMeta.content.includes('width=device-width') && viewportMeta.content.includes('initial-scale=')) {
                return { status: 'pass', message: 'Viewport meta tag found, indicating mobile responsiveness. Essential for user experience.' };
            }
            return { status: 'fail', message: 'Viewport meta tag is missing or incorrect. Your site may not be mobile-friendly, which is crucial for AdSense.' };
        });

        runCheck('Language Declaration (`lang` attribute)', CAT_STRUCT_ACC, 5, () => {
            const htmlLang = doc.documentElement.getAttribute('lang');
            if (htmlLang && htmlLang.trim().length > 0) {
                return { status: 'pass', message: `HTML language declared as "${htmlLang}". Good for accessibility and SEO.` };
            }
            return { status: 'warn', message: 'No HTML language attribute (`lang`) found. Recommended for accessibility and search engines.' };
        });

        runCheck('Favicon Present', CAT_STRUCT_ACC, 2, () => {
            const faviconLink = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
            if (faviconLink && faviconLink.href) {
                return { status: 'pass', message: 'Favicon link found. Contributes to site professionalism.' };
            }
            return { status: 'warn', message: 'No favicon detected. A favicon improves brand recognition and user experience.' };
        });

        runCheck('Sitemap Link/Presence', CAT_STRUCT_ACC, 5, () => {
            const sitemapLink = findLink(['sitemap.xml', 'sitemap'], doc);
            const robotsTxtLink = doc.querySelector('link[rel="sitemap"]'); 

            const robotsTxtSitemapFound = robotsCheckResult.message.toLowerCase().includes('sitemap:') && robotsCheckResult.status !== 'fail';

            if (sitemapLink || robotsTxtLink || robotsTxtSitemapFound) {
                return { status: 'pass', message: 'Sitemap link/presence detected (via HTML link, or robots.txt mention). Good for crawlability.' };
            }
            return { status: 'warn', message: 'No sitemap link found. Consider adding one in your footer or robots.txt for better crawlability and indexation by search engines.' };
        });

        runCheck('Common Broken Link Patterns', CAT_STRUCT_ACC, 5, () => {
            const brokenLinkKeywords = ['404', 'not found', 'page not found', 'error 404'];
            const pageText = doc.body.textContent.toLowerCase();
            const pageTitle = doc.querySelector('title')?.textContent.toLowerCase();

            if (brokenLinkKeywords.some(keyword => pageText.includes(keyword) || pageTitle?.includes(keyword))) {
                return { status: 'fail', message: 'Common "page not found" indicators found on the page\'s content or title. This URL might be a broken link or an error page. AdSense requires a good user experience.' };
            }

            const hashLinks = Array.from(doc.querySelectorAll('a[href^="#"]'));
            const brokenHashLinks = hashLinks.filter(link => {
                const id = link.getAttribute('href').substring(1);
                return id && !doc.getElementById(id);
            });
            if (brokenHashLinks.length > 0) {
                 return { status: 'warn', message: `Found ${brokenHashLinks.length} internal hash links (#links) that might not point to valid elements on this page. Check for broken anchor links.` };
            }

            return { status: 'pass', message: 'No obvious "page not found" indicators or problematic hash links detected on this page\'s content.' };
        });

        runCheck('Google Analytics / Tag Manager Presence', CAT_STRUCT_ACC, 5, () => {
            const scripts = Array.from(doc.querySelectorAll('script'));
            const hasGTag = scripts.some(s => s.src?.includes('googletagmanager.com/gtag/js') || s.textContent.includes('gtag('));
            const hasGA = scripts.some(s => s.src?.includes('google-analytics.com/analytics.js') || s.textContent.includes('ga('));

            if (hasGTag || hasGA) {
                return { status: 'pass', message: 'Google Analytics (gtag.js) or Google Tag Manager script detected. Good for tracking visitors and demonstrating site ownership/interest.' };
            }
            return { status: 'warn', message: 'No Google Analytics or Tag Manager script found. While not mandatory for AdSense approval, tracking helps you understand your audience and can be a positive signal.' };
        });

        // --- Manual Checks for Content Quality ---
        checks.push({ name: 'Content Originality & Value', category: CAT_MANUAL, status: 'manual', message: 'Is your content 100% original, unique, and written from experience? Does it provide real, substantial value that users can\'t easily find elsewhere? (Google\'s E-E-A-T guidelines are critical).' });
        checks.push({ name: 'Expertise, Experience, Authority, Trust (E-E-A-T)', category: CAT_MANUAL, status: 'manual', message: 'Does your site demonstrate clear expertise and experience on its topic? Is the information accurate and trustworthy? Is there clear authorship information (e.g., author bios, About Us page with team info)?' });
        checks.push({ name: 'Readability & Grammar', category: CAT_MANUAL, status: 'manual', message: 'Is the content well-written, with proper grammar, spelling, and punctuation? Is it easy to read with clear headings, short paragraphs, and a logical flow?' });
        checks.push({ name: 'Sufficient Pages & Site Structure', category: CAT_MANUAL, status: 'manual', message: 'Does your site have enough distinct, high-quality pages beyond just blog posts? Is it well-organized with a clear hierarchy, internal linking, and no dead ends?' });
        checks.push({ name: 'Compliance with AdSense Policies', category: CAT_MANUAL, status: 'manual', message: 'Does your content strictly adhere to AdSense Content Policies (e.g., no adult content, illegal activities, hate speech, dangerous content)? Review all policies thoroughly.' });
        checks.push({ name: 'User Experience & Layout', category: CAT_MANUAL, status: 'manual', message: 'Is your site\'s design clean, professional, and easy to use? Is it free of intrusive pop-ups, excessive ads (if any are already present), or confusing layouts? Navigation should be intuitive and clear.' });


        res.json({ score: Math.min(100, Math.round(score)), checks, finalResolvedUrl });

    } catch (error) {
        console.error("Server-side analysis error:", error);
        res.status(500).json({ error: `An internal server error occurred during analysis: ${error.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    // Replit will automatically start the server when you click "Run"
    // and provide a public URL for it.
});
