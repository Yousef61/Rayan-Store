'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `${Number(n).toLocaleString('ar-EG')} ج.م`;
  const ICONS = { 'school-bags': '🎒', 'nursery-bags': '👜', scarves: '🧕', bandanas: '🎀' };
  const icon = (slug) => ICONS[slug] || '🛍️';

  let settings = {};
  let categories = [];
  let productsCache = null;
  // Each render gets a fresh AbortSignal so listeners on <main> from the previous render are removed.
  let viewAbort = new AbortController();
  function viewSignal() {
    viewAbort.abort();
    viewAbort = new AbortController();
    return viewAbort.signal;
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'حصل خطأ، حاول مرة أخرى');
    return data;
  }
  async function allProducts(force) {
    if (!productsCache || force) productsCache = await api('/api/products');
    return productsCache;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- cart (stored in the browser) ----------
  const cart = {
    get() {
      try { return JSON.parse(localStorage.getItem('rayan_cart')) || []; } catch { return []; }
    },
    save(items) {
      try { localStorage.setItem('rayan_cart', JSON.stringify(items)); } catch { /* storage unavailable */ }
      updateBadge();
    },
    add(id, qty, option) {
      const items = cart.get();
      const found = items.find((i) => i.id === id && i.option === option);
      if (found) found.qty += qty; else items.push({ id, qty, option });
      cart.save(items);
    },
    count() { return cart.get().reduce((s, i) => s + i.qty, 0); },
  };
  function updateBadge() { $('#cartCount').textContent = cart.count(); }

  function waLink(text) {
    const n = (settings.whatsapp || '').replace(/[^\d]/g, '');
    if (!n) return null;
    const intl = n.startsWith('0') ? `2${n}` : n;
    return `https://wa.me/${intl}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  }

  // ---------- views ----------
  function productCard(p) {
    const img = p.images[0] ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy">` : `<div class="placeholder">${icon(p.category_slug)}</div>`;
    let tag = '';
    if (p.stock <= 0) tag = '<span class="tag out">نفذت الكمية</span>';
    else if (p.old_price && p.old_price > p.price) tag = `<span class="tag">خصم ${Math.round((1 - p.price / p.old_price) * 100)}%</span>`;
    return `<a class="card" href="#/product/${p.id}">
      <div class="thumb">${img}${tag}</div>
      <div class="body">
        <h3>${esc(p.name)}</h3>
        <div><span class="price">${money(p.price)}</span>${p.old_price && p.old_price > p.price ? `<span class="old-price">${money(p.old_price)}</span>` : ''}</div>
      </div>
    </a>`;
  }

  const grid = (list) => list.length
    ? `<div class="grid">${list.map(productCard).join('')}</div>`
    : '<div class="empty"><div class="big">🛍️</div><p>لا توجد منتجات هنا حالياً.</p></div>';

  async function viewHome() {
    const products = await allProducts();
    const featured = products.filter((p) => p.featured);
    const latest = products.slice().sort((a, b) => b.id - a.id).slice(0, 12);
    app.innerHTML = `
      <section class="hero">
        <h1>كل اللي محتاجه لأولادك ولكِ في مكان واحد ✨</h1>
        <p>${esc(settings.tagline)}</p>
        <div class="perks"><span>💵 الدفع عند الاستلام</span><span>🚚 توصيل لكل المحافظات</span><span>⭐ خامات ممتازة</span></div>
      </section>
      <div class="section-title"><h2>الأقسام</h2></div>
      <div class="cat-grid">${categories.map((c) => `
        <a class="cat-card" href="#/category/${esc(c.slug)}"><div class="icon">${icon(c.slug)}</div><b>${esc(c.name)}</b><small>${c.product_count} منتج</small></a>`).join('')}
      </div>
      ${featured.length ? `<div class="section-title"><h2>منتجات مميزة</h2></div>${grid(featured)}` : ''}
      <div class="section-title"><h2>وصل حديثاً</h2></div>
      ${grid(latest)}`;
  }

  async function viewCategory(slug) {
    const cat = categories.find((c) => c.slug === slug);
    if (!cat) return viewNotFound();
    const products = (await allProducts()).filter((p) => p.category_slug === slug);
    document.title = `${cat.name} | ${settings.store_name}`;
    app.innerHTML = `<div class="section-title"><h2>${icon(slug)} ${esc(cat.name)}</h2><span>${products.length} منتج</span></div>${grid(products)}`;
  }

  async function viewSearch(q) {
    const list = await api(`/api/products?q=${encodeURIComponent(q)}`);
    app.innerHTML = `<div class="section-title"><h2>نتائج البحث عن "${esc(q)}"</h2><span>${list.length} منتج</span></div>${grid(list)}`;
  }

  async function viewProduct(id) {
    let p;
    try { p = await api(`/api/products/${Number(id)}`); } catch { return viewNotFound(); }
    document.title = `${p.name} | ${settings.store_name}`;
    let qty = 1;
    let option = p.options.length === 1 ? p.options[0] : '';
    const imgs = p.images.length ? p.images : [null];
    const stockNote = p.stock <= 0 ? '<span class="stock-note out">نفذت الكمية حالياً</span>'
      : p.stock <= 3 ? `<span class="stock-note low">باقي ${p.stock} قطع فقط!</span>` : '<span class="stock-note">✓ متوفر</span>';

    app.innerHTML = `
      <div class="crumbs"><a href="#/">الرئيسية</a> / ${p.category_slug ? `<a href="#/category/${esc(p.category_slug)}">${esc(p.category_name)}</a> / ` : ''}${esc(p.name)}</div>
      <div class="product">
        <div class="gallery">
          <div class="main">${imgs[0] ? `<img id="mainImg" src="${esc(imgs[0])}" alt="${esc(p.name)}">` : `<div class="placeholder">${icon(p.category_slug)}</div>`}</div>
          ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((u, i) => `<button data-src="${esc(u)}" class="${i ? '' : 'active'}"><img src="${esc(u)}" alt=""></button>`).join('')}</div>` : ''}
        </div>
        <div class="info">
          <h1>${esc(p.name)}</h1>
          <div><span class="price">${money(p.price)}</span>${p.old_price && p.old_price > p.price ? `<span class="old-price">${money(p.old_price)}</span>` : ''}</div>
          ${stockNote}
          ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
          ${p.options.length ? `<div class="field"><label>اختر اللون / الموديل:</label><div class="opts" id="opts">${p.options.map((o) => `<button type="button" data-o="${esc(o)}" class="${o === option ? 'active' : ''}">${esc(o)}</button>`).join('')}</div></div>` : ''}
          ${p.stock > 0 ? `<div class="field"><label>الكمية:</label><div class="qty"><button type="button" id="qPlus">+</button><span id="qVal">1</span><button type="button" id="qMinus">−</button></div></div>` : ''}
          <div class="actions">
            <button class="btn" id="addBtn" ${p.stock <= 0 ? 'disabled' : ''}>🛒 أضف للسلة</button>
            <button class="btn outline" id="buyBtn" ${p.stock <= 0 ? 'disabled' : ''}>اشتري الآن</button>
            ${waLink() ? '<a class="btn wa" id="waBtn" target="_blank" rel="noopener">اسأل على واتساب</a>' : ''}
          </div>
        </div>
      </div>`;

    app.querySelectorAll('.thumbs button').forEach((b) => b.addEventListener('click', () => {
      $('#mainImg').src = b.dataset.src;
      app.querySelectorAll('.thumbs button').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('#opts')?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      option = b.dataset.o;
      $('#opts').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
    const setQty = (n) => { qty = Math.max(1, Math.min(p.stock, n)); $('#qVal').textContent = qty; };
    $('#qPlus')?.addEventListener('click', () => setQty(qty + 1));
    $('#qMinus')?.addEventListener('click', () => setQty(qty - 1));
    const add = () => {
      if (p.options.length && !option) { toast('من فضلك اختر اللون / الموديل'); return false; }
      const inCart = cart.get().filter((i) => i.id === p.id).reduce((s, i) => s + i.qty, 0);
      if (inCart + qty > p.stock) { toast(`المتاح ${p.stock} قطع فقط`); return false; }
      cart.add(p.id, qty, option);
      return true;
    };
    $('#addBtn').addEventListener('click', () => { if (add()) toast('✓ تمت الإضافة للسلة'); });
    $('#buyBtn').addEventListener('click', () => { if (add()) location.hash = '#/checkout'; });
    const wa = $('#waBtn');
    if (wa) wa.href = waLink(`السلام عليكم، عايز أسأل عن: ${p.name}\n${location.href}`);
  }

  // Joins the cart stored in the browser with fresh product data, dropping anything no longer available.
  async function cartLines() {
    const products = await allProducts(true);
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = cart.get().filter((i) => byId.has(i.id));
    cart.save(items);
    return items.map((i) => ({ ...i, p: byId.get(i.id) }));
  }

  function totals(lines) {
    const subtotal = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
    const free = settings.free_shipping_over > 0 && subtotal >= settings.free_shipping_over;
    const shipping = free ? 0 : settings.shipping_fee;
    return { subtotal, shipping, total: subtotal + shipping };
  }

  function summaryHtml(lines) {
    const t = totals(lines);
    return `
      <div class="summary-row"><span>المجموع</span><b>${money(t.subtotal)}</b></div>
      <div class="summary-row"><span>الشحن</span><b>${t.shipping ? money(t.shipping) : 'مجاني 🎉'}</b></div>
      ${settings.free_shipping_over > 0 && t.shipping ? `<small style="color:var(--muted)">شحن مجاني للطلبات فوق ${money(settings.free_shipping_over)}</small>` : ''}
      <div class="summary-row total"><span>الإجمالي</span><span>${money(t.total)}</span></div>`;
  }

  async function viewCart() {
    document.title = `السلة | ${settings.store_name}`;
    const lines = await cartLines();
    if (!lines.length) {
      app.innerHTML = '<div class="empty"><div class="big">🛒</div><p>السلة فارغة</p><a class="btn" href="#/">تسوق الآن</a></div>';
      return;
    }
    app.innerHTML = `
      <div class="section-title"><h2>سلة المشتريات</h2></div>
      <div class="cart-layout">
        <div class="panel">${lines.map((l, idx) => `
          <div class="cart-item">
            ${l.p.images[0] ? `<img src="${esc(l.p.images[0])}" alt="">` : `<div class="placeholder">${icon(l.p.category_slug)}</div>`}
            <div>
              <h4><a href="#/product/${l.p.id}">${esc(l.p.name)}</a></h4>
              ${l.option ? `<small>${esc(l.option)}</small><br>` : ''}
              <span class="price">${money(l.p.price)}</span>
              <div style="margin-top:6px"><button class="remove" data-rm="${idx}">✕ حذف</button></div>
            </div>
            <div class="qty"><button data-inc="${idx}">+</button><span>${l.qty}</span><button data-dec="${idx}">−</button></div>
          </div>`).join('')}
        </div>
        <div class="panel">${summaryHtml(lines)}<a class="btn block" style="margin-top:14px" href="#/checkout">إتمام الطلب</a></div>
      </div>`;

    app.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const items = lines.map(({ id, qty, option }) => ({ id, qty, option }));
      const i = Number(b.dataset.rm ?? b.dataset.inc ?? b.dataset.dec);
      if (Number.isNaN(i) || !items[i]) return;
      if (b.dataset.rm !== undefined) items.splice(i, 1);
      else if (b.dataset.inc !== undefined) {
        const total = items.filter((x) => x.id === items[i].id).reduce((s, x) => s + x.qty, 0);
        if (total >= lines[i].p.stock) { toast(`المتاح ${lines[i].p.stock} قطع فقط`); return; }
        items[i].qty++;
      } else if (items[i].qty > 1) items[i].qty--;
      cart.save(items);
      viewCart();
    }, { signal: viewSignal() });
  }

  async function viewCheckout() {
    document.title = `إتمام الطلب | ${settings.store_name}`;
    const lines = await cartLines();
    if (!lines.length) { location.hash = '#/cart'; return; }
    app.innerHTML = `
      <div class="section-title"><h2>إتمام الطلب</h2></div>
      <div class="cart-layout">
        <form class="panel" id="orderForm" novalidate>
          <div class="form-grid">
            <div class="field full"><label for="f_name">الاسم بالكامل *</label><input type="text" id="f_name" name="customer_name" required autocomplete="name"></div>
            <div class="field"><label for="f_phone">رقم الموبايل *</label><input type="tel" id="f_phone" name="phone" required placeholder="01xxxxxxxxx" inputmode="tel" autocomplete="tel"></div>
            <div class="field"><label for="f_phone2">رقم موبايل آخر (اختياري)</label><input type="tel" id="f_phone2" name="phone2" inputmode="tel"></div>
            <div class="field full"><label for="f_gov">المحافظة *</label><select id="f_gov" name="governorate" required><option value="">اختر المحافظة</option>${settings.governorates.map((g) => `<option>${esc(g)}</option>`).join('')}</select></div>
            <div class="field full"><label for="f_addr">العنوان بالتفصيل *</label><textarea id="f_addr" name="address" rows="2" required placeholder="المدينة / المنطقة، الشارع، رقم العمارة، الدور"></textarea></div>
            <div class="field full"><label for="f_notes">ملاحظات (اختياري)</label><textarea id="f_notes" name="notes" rows="2"></textarea></div>
          </div>
          <div id="formError" class="error" hidden></div>
          <p style="color:var(--muted)">💵 الدفع نقداً عند الاستلام</p>
          <button class="btn block" id="submitBtn">تأكيد الطلب</button>
        </form>
        <div class="panel">
          ${lines.map((l) => `<div class="summary-row"><span>${esc(l.p.name)}${l.option ? ` (${esc(l.option)})` : ''} × ${l.qty}</span><b>${money(l.p.price * l.qty)}</b></div>`).join('')}
          <hr style="border:0;border-top:1px solid var(--border)">
          ${summaryHtml(lines)}
        </div>
      </div>`;

    try {
      const saved = JSON.parse(localStorage.getItem('rayan_customer') || '{}');
      for (const [k, v] of Object.entries(saved)) { const el = $(`[name="${k}"]`); if (el) el.value = v; }
    } catch { /* ignore */ }

    $('#orderForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      const err = $('#formError');
      err.hidden = true;
      const btn = $('#submitBtn');
      btn.disabled = true;
      btn.textContent = 'جاري إرسال الطلب...';
      try {
        const order = await api('/api/orders', {
          method: 'POST',
          body: JSON.stringify({ ...data, items: cart.get() }),
        });
        try {
          const { customer_name, phone, phone2, governorate, address } = data;
          localStorage.setItem('rayan_customer', JSON.stringify({ customer_name, phone, phone2, governorate, address }));
          sessionStorage.setItem('rayan_last_order', JSON.stringify({ ...order, customer_name, phone }));
        } catch { /* ignore */ }
        cart.save([]);
        productsCache = null;
        location.hash = `#/done/${order.id}`;
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = 'تأكيد الطلب';
      }
    });
  }

  function viewDone(id) {
    let order = null;
    try { order = JSON.parse(sessionStorage.getItem('rayan_last_order')); } catch { /* ignore */ }
    const msg = order && order.id === Number(id)
      ? `السلام عليكم، عملت طلب رقم #${order.id} من الموقع\n${order.items.map((i) => `- ${i.name}${i.option ? ` (${i.option})` : ''} × ${i.qty}`).join('\n')}\nالإجمالي: ${order.total} ج.م\nالاسم: ${order.customer_name}`
      : `السلام عليكم، عملت طلب رقم #${id} من الموقع`;
    const wa = waLink(msg);
    app.innerHTML = `
      <div class="panel success-box">
        <div class="big">🎉</div>
        <h2>تم استلام طلبك بنجاح!</h2>
        <p>رقم الطلب: <b>#${Number(id)}</b></p>
        ${order && order.id === Number(id) ? `<p>الإجمالي: <b>${money(order.total)}</b> (الدفع عند الاستلام)</p>` : ''}
        <p>هنتواصل معاك قريباً لتأكيد الطلب وميعاد التوصيل.</p>
        <div class="actions" style="justify-content:center">
          ${wa ? `<a class="btn wa" href="${esc(wa)}" target="_blank" rel="noopener">أكد الطلب على واتساب</a>` : ''}
          <a class="btn outline" href="#/">متابعة التسوق</a>
        </div>
      </div>`;
  }

  function viewNotFound() {
    app.innerHTML = '<div class="empty"><div class="big">🤷</div><p>الصفحة غير موجودة</p><a class="btn" href="#/">الرئيسية</a></div>';
  }

  // ---------- router ----------
  async function route() {
    const [, page, arg] = (location.hash.replace(/^#/, '') || '/').split('/');
    document.title = `${settings.store_name} | ${settings.tagline}`;
    document.querySelectorAll('#catsNav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === location.hash || (!page && a.dataset.home)));
    viewSignal();
    app.innerHTML = '<div class="loader"></div>';
    try {
      if (!page) await viewHome();
      else if (page === 'category') await viewCategory(decodeURIComponent(arg || ''));
      else if (page === 'product') await viewProduct(arg);
      else if (page === 'search') await viewSearch(decodeURIComponent(arg || ''));
      else if (page === 'cart') await viewCart();
      else if (page === 'checkout') await viewCheckout();
      else if (page === 'done') viewDone(arg);
      else viewNotFound();
    } catch (e) {
      app.innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">إعادة المحاولة</button></div>`;
    }
    window.scrollTo(0, 0);
  }

  async function init() {
    $('#year').textContent = new Date().getFullYear();
    updateBadge();
    try {
      [settings, categories] = await Promise.all([api('/api/settings'), api('/api/categories')]);
    } catch (e) {
      app.innerHTML = `<div class="empty"><p>تعذر تحميل المتجر: ${esc(e.message)}</p></div>`;
      return;
    }
    $('#storeName').textContent = settings.store_name;
    $('#tagline').textContent = settings.tagline;
    if (settings.announcement) { $('#announce').textContent = settings.announcement; $('#announce').hidden = false; }
    $('#catsNav').innerHTML = `<a href="#/" data-home="1">الكل</a>${categories.map((c) => `<a href="#/category/${esc(c.slug)}">${icon(c.slug)} ${esc(c.name)}</a>`).join('')}`;

    const links = [];
    if (settings.phone) links.push(`<a href="tel:${esc(settings.phone)}">📞 ${esc(settings.phone)}</a>`);
    if (waLink()) links.push(`<a href="${esc(waLink())}" target="_blank" rel="noopener">💬 واتساب</a>`);
    if (settings.facebook_url) links.push(`<a href="${esc(settings.facebook_url)}" target="_blank" rel="noopener">📘 صفحتنا على فيسبوك</a>`);
    $('#contactLinks').innerHTML = links.join('');
    if (waLink()) { $('#waFloat').href = waLink(); $('#waFloat').hidden = false; }

    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#searchInput').value.trim();
      if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
    });
    window.addEventListener('hashchange', route);
    window.addEventListener('storage', updateBadge);
    route();
  }

  init();
})();
