const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PAGE_URL = 'https://www.meteo.gov.ua/ua/Shchodenna-hidrolohichna-situaciya';
const CACHE_FILE = path.join(__dirname, 'marker-cache.json');
const OUTPUT_FILE = path.join(__dirname, 'makoshine.json');

const TARGET = {
  id: '80127',
  post: 'Макошине'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function saveResult(data) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parsePopupText(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();

  const result = {
    post: null,
    river: null,
    observed_at: null,
    water_level_cm: null,
    delta_direction: null,
    delta_24h_cm: null,
    water_temperature_c: null,
    raw_text: cleaned
  };

  let m;

  m = cleaned.match(/Пост:\s*([^\n\r]+?)(?=\s*Річка:|\s*Дані на|\s*Фактичний рівень|$)/iu);
  if (m) result.post = m[1].trim();

  m = cleaned.match(/Річка:\s*([^\n\r]+?)(?=\s*Дані на|\s*Фактичний рівень|$)/iu);
  if (m) result.river = m[1].trim();

  m = cleaned.match(/Дані на\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4},\s*[0-9]{2}:[0-9]{2})/iu);
  if (m) result.observed_at = m[1].trim();

  m = cleaned.match(/Фактичний рівень води:\s*(-?[0-9]+)\s*см/iu);
  if (m) result.water_level_cm = parseInt(m[1], 10);

  m = cleaned.match(/Рівень за останню добу:\s*(збільшився|зменшився)\s*на\s*([0-9]+)\s*см/iu);
  if (m) {
    result.delta_direction = m[1];
    const delta = parseInt(m[2], 10);
    result.delta_24h_cm = m[1] === 'зменшився' ? -delta : delta;
  } else if (/Рівень за останню добу:\s*без змін/iu.test(cleaned)) {
    result.delta_direction = 'без змін';
    result.delta_24h_cm = 0;
  }

  m = cleaned.match(/Температура води:\s*(-?[0-9]+(?:[.,][0-9]+)?)°C/iu);
  if (m) result.water_temperature_c = parseFloat(m[1].replace(',', '.'));

  return result;
}

async function getPopupText(page) {
  const popup = page.locator('.leaflet-popup-content');
  if (await popup.count()) {
    return await popup.first().innerText();
  }
  return '';
}

async function clickMarkerAndRead(page, index) {
  const markers = page.locator('.leaflet-marker-icon');
  const count = await markers.count();

  if (index < 0 || index >= count) {
    return { ok: false, error: `Індекс ${index} поза межами. Маркерів: ${count}` };
  }

  const marker = markers.nth(index);

  try {
    await marker.click({ force: true, timeout: 5000 });
    await sleep(400);

    const popupText = await getPopupText(page);
    if (!popupText) {
      return { ok: false, error: `Немає popup після кліку по маркеру ${index}` };
    }

    return {
      ok: true,
      index,
      popupText,
      parsed: parsePopupText(popupText)
    };
  } catch (e) {
    return {
      ok: false,
      error: `Помилка кліку по маркеру ${index}: ${e.message}`
    };
  }
}

async function getUniqueMarkerIndices(page) {
  const markers = page.locator('.leaflet-marker-icon');
  const count = await markers.count();
  const seen = new Set();
  const result = [];

  for (let i = 0; i < count; i++) {
    try {
      const style = await markers.nth(i).evaluate(el => el.style.transform || '');
      if (!seen.has(style)) {
        seen.add(style);
        result.push(i);
      }
    } catch (e) {}
  }

  return result;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 0
  });

  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 }
  });

  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.leaflet-container', { timeout: 30000 });
    await page.waitForSelector('.leaflet-marker-icon', { timeout: 30000 });
    await sleep(2000);

    const cache = loadCache();
    const cachedIndex = cache[TARGET.id];

    if (typeof cachedIndex === 'number') {
      console.log(`Пробую кешований індекс: ${cachedIndex}`);

      const fastTry = await clickMarkerAndRead(page, cachedIndex);

      if (
        fastTry.ok &&
        fastTry.parsed.post &&
        fastTry.parsed.post.toLowerCase() === TARGET.post.toLowerCase()
      ) {
        const result = {
          ok: true,
          mode: 'cache',
          target: TARGET,
          marker_match: {
            found_index: cachedIndex
          },
          data: fastTry.parsed,
          fetched_at: new Date().toISOString()
        };

        saveResult(result);
        console.log(JSON.stringify(result, null, 2));
        console.log(`\nJSON збережено у файл: ${OUTPUT_FILE}`);
        await browser.close();
        return;
      }

      console.log('Кешований індекс не підійшов, запускаю повний пошук...');
    }

    const uniqueIndices = await getUniqueMarkerIndices(page);
    console.log(`Унікальних маркерів для перевірки: ${uniqueIndices.length}`);

    let found = false;
    let foundIndex = -1;
    let popupText = '';

    for (const i of uniqueIndices) {
      const result = await clickMarkerAndRead(page, i);

      if (!result.ok) {
        console.log(result.error);
        continue;
      }

      popupText = result.popupText;
      const shortText = popupText.replace(/\s+/g, ' ').trim();

      console.log(`Маркер ${i}: ${shortText}`);

      if (
        result.parsed.post &&
        result.parsed.post.toLowerCase() === TARGET.post.toLowerCase()
      ) {
        found = true;
        foundIndex = i;
        break;
      }
    }

    if (!found) {
      const errorResult = {
        ok: false,
        error: 'Не вдалося знайти popup для поста Макошине',
        fetched_at: new Date().toISOString()
      };

      saveResult(errorResult);
      console.log(JSON.stringify(errorResult, null, 2));
      await browser.close();
      return;
    }

    const parsed = parsePopupText(popupText);

    cache[TARGET.id] = foundIndex;
    saveCache(cache);

    const result = {
      ok: true,
      mode: 'scan',
      target: TARGET,
      marker_match: {
        found_index: foundIndex
      },
      data: parsed,
      fetched_at: new Date().toISOString()
    };

    saveResult(result);
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nJSON збережено у файл: ${OUTPUT_FILE}`);
    console.log('Індекс збережено в marker-cache.json');
  } catch (err) {
    const errorResult = {
      ok: false,
      error: err.message,
      fetched_at: new Date().toISOString()
    };

    saveResult(errorResult);
    console.log(JSON.stringify(errorResult, null, 2));
  } finally {
    await browser.close();
  }
})();