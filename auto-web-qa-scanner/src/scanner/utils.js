

const injectCssPathHelper = async (context) => {
  await context.addInitScript(`
    window.getCssPath = function(el) {
      if (!(el instanceof Element)) return '';
      const path = [];
      while (el.nodeType === Node.ELEMENT_NODE) {
          let selector = el.nodeName.toLowerCase();
          if (el.id && /^[a-zA-Z][a-zA-Z0-9\-_]*$/.test(el.id)) {
              selector += '#' + el.id;
              path.unshift(selector);
              break;
          } else {
              let sib = el, nth = 1;
              while (sib = sib.previousElementSibling) {
                  if (sib.nodeName.toLowerCase() == selector) nth++;
              }
              if (nth != 1) selector += ":nth-of-type("+nth+")";
          }
          path.unshift(selector);
          el = el.parentNode;
      }
      return path.join(' > ');
    }
  `);
};

const waitForPageAssets = async (page) => {
  await page.evaluate(async () => {
    // 1. Wait for all fonts to finish loading
    await document.fonts.ready;
    
    // 2. Wait for all images in the initial DOM snapshot to fully download
    const images = Array.from(document.querySelectorAll('img'));
    await Promise.all(images.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        // We resolve on both load and error so a single broken layout image won't hang the scanner
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
  });
};

module.exports = { injectCssPathHelper, waitForPageAssets };
