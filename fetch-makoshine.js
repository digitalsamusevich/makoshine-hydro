const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PAGE_URL = 'https://www.meteo.gov.ua/ua/Shchodenna-hidrolohichna-situaciya';
const CACHE_FILE = path.join(__dirname, 'marker-cache.json');
const OUTPUT_FILE = path.join(__dirname, 'desna-posts.json');
const HISTORY_FILE = path.join(__dirname, 'desna-history.json');

const TARGETS = [
  { id: '80122', post: 'Новгород Сіверський' },
  { id: '80123', post: 'Розльоти' },
  { id: '80127', post: 'Макошине' },
  { id: '80131', post: 'Чернігів' }
];

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

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function updateHistory(finalResult) {
  const history = loadHistory();
  const today = new Date().toISOString().slice(0, 10);

  if (!finalResult.posts) {
    saveHistory(history);
    return;
  }

  for (const id in finalResult.posts) {
    const post = finalResult.posts[id];

    if (!history[id]) {
      history[id] = [];
    }

    const lastEntry = history[id][history[id].length - 1];

    // якщо запис за сьогодні вже існує — оновлюємо, а не дублюємо
    if (lastEntry && lastEntry.date === today) {
      lastEntry.level = post.water_level_cm;
    } else {
      history[id].push({
        date: today,
        level: post.water_level_cm
      });
    }

   
  }

  saveHistory(history);
}

function formatShortDate(dateStr) {
  const parts = dateStr.split('-'); // YYYY-MM-DD
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}.${parts[1]}`;
}

function buildQuickChartUrl(title, historyItems) {
  const labels = historyItems.map(item => formatShortDate(item.date));
  const data = historyItems.map(item => item.level);

  const firstLevel = data.length ? data[0] : 0;
  const lastLevel = data.length ? data[data.length - 1] : 0;
  const isFalling = lastLevel < firstLevel;

  const lineColor = isFalling ? 'rgb(22, 163, 74)' : 'rgb(37, 99, 235)';
  const fillColor = isFalling ? 'rgba(22, 163, 74, 0.20)' : 'rgba(37, 99, 235, 0.20)';

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: title,
          data: data,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          tension: 0.35,
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 5,
          pointBackgroundColor: lineColor,
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2
        }
      ]
    },
    options: {
      layout: {
        padding: {
          top: 10,
          right: 18,
          bottom: 10,
          left: 10
        }
      },
      plugins: {
        title: {
          display: true,
          text: `${title} — рівень води`,
          font: {
            size: 18,
            family: 'sans-serif'
          },
          color: '#1f2937',
          padding: {
            bottom: 12
          }
        },
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#6b7280',
            font: {
              size: 11
            }
          },
          grid: {
            color: 'rgba(0,0,0,0.04)'
          }
        },
        y: {
          ticks: {
            color: '#6b7280',
            font: {
              size: 11
            },
            callback: 'function(value){ return value + " см"; }'
          },
          title: {
            display: true,
            text: 'Рівень, см',
            color: '#374151',
            font: {
              size: 12
            }
          },
          grid: {
            color: 'rgba(0,0,0,0.06)'
          }
        }
      }
    },
    plugins: [
      {
        id: 'lastValueLabel',
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          if (!meta || !meta.data || !meta.data.length) return;

          const lastPoint = meta.data[meta.data.length - 1];
          const value = data[data.length - 1];
          if (value === undefined) return;

          ctx.save();
          ctx.font = 'bold 12px sans-serif';
          ctx.fillStyle = lineColor;
          ctx.textAlign = 'left';
          ctx.fillText(`${value} см`, lastPoint.x + 8, lastPoint.y - 8);
          ctx.restore();
        }
      }
    ]
  };

  return 'https://quickchart.io/chart?width=900&height=420&c=' + encodeURIComponent(JSON.stringify(chartConfig));
}

function attachChartsToResult(finalResult) {
  const history = loadHistory();

  if (!finalResult.posts) return finalResult;

  for (const id in finalResult.posts) {
    const post = finalResult.posts[id];
    const historyItems = history[id] || [];

    post.history_points = historyItems;
    post.chart_url = buildQuickChartUrl(post.post, historyItems);
  }

  return finalResult;
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

async function findTarget(page, target, cache, uniqueIndices) {
  const cachedIndex = cache[target.id];

  if (typeof cachedIndex === 'number') {
    const fastTry = await clickMarkerAndRead(page, cachedIndex);

    if (
      fastTry.ok &&
      fastTry.parsed.post &&
      fastTry.parsed.post.toLowerCase() === target.post.toLowerCase()
    ) {
      return {
        ok: true,
        mode: 'cache',
        found_index: cachedIndex,
        data: fastTry.parsed
      };
    }
  }

  for (const i of uniqueIndices) {
    const result = await clickMarkerAndRead(page, i);

    if (!result.ok) continue;

    const parsedPost = result.parsed.post ? result.parsed.post.toLowerCase() : '';
    if (parsedPost === target.post.toLowerCase()) {
      cache[target.id] = i;
      return {
        ok: true,
        mode: 'scan',
        found_index: i,
        data: result.parsed
      };
    }
  }

  return {
    ok: false,
    error: `Не вдалося знайти пост: ${target.post}`
  };
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
    const uniqueIndices = await getUniqueMarkerIndices(page);

    const posts = {};
    const errors = [];

    for (const target of TARGETS) {
      const result = await findTarget(page, target, cache, uniqueIndices);

      if (result.ok) {
        posts[target.id] = {
          id: target.id,
          post: target.post,
          mode: result.mode,
          found_index: result.found_index,
          ...result.data
        };
      } else {
        errors.push({
          id: target.id,
          post: target.post,
          error: result.error
        });
      }
    }

    saveCache(cache);

    const finalResult = {
      ok: errors.length === 0,
      river_group: 'Десна',
      posts,
      errors,
      fetched_at: new Date().toISOString()
    };

    updateHistory(finalResult);
attachChartsToResult(finalResult);
saveResult(finalResult);
console.log(JSON.stringify(finalResult, null, 2));
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
