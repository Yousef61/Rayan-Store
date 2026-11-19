'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `${Number(n).toLocaleString('ar-EG')} ج.م`;
  const STATUS = { new: 'جديد', confirmed: 'تم التأكيد', shipped: 'تم الشحن', delivered: 'تم التسليم', cancelled: 'ملغي' };
  const dialog = $('#dialog');
  let tab = 'orders';
  let categories = [];
  let orderFilter = 'new';
  let viewAbort = new AbortController();

  async function api(url, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const res = await fetch(url, { ...opts, headers: isForm ? {} : { 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('انتهت الجلسة، سجل الدخول مرة أخرى'); }
    if (!res.ok) throw new Error(data.error || 'حصل خطأ');
    return data;
  }
  const send = (url, method, body) => api(url, { method, body: JSON.stringify(body) });

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
  }
  const fail = (e) => toast(`⚠️ ${e.message}`);

  // Re-render helper: drop listeners on #view from the last render.
  function signal() {
    viewAbort.abort();
    viewAbort = new AbortController();
    return viewAbort.signal;
  }

  // ---------- auth ----------
  function showLogin() {
    $('#dash').hidden = true;
    $('#login').hidden = false;
    $('#pw').focus();
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError');
    err.hidden = true;
    try {
      await send('/api/admin/login', 'POST', { password: $('#pw').value });
      $('#pw').value = '';
      start();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await send('/api/admin/logout', 'POST', {}).catch(() => {});
    showLogin();
  });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });

  async function refreshBadge() {
    try {
      const s = await api('/api/admin/stats');
      $('#newBadge').textContent = s.new_orders;
      $('#newBadge').hidden = !s.new_orders;
      return s;
    } catch { return null; }
  }

  async function render() {
    signal();
    view.innerHTML = '<div class="loader"></div>';
    try {
      categories = await api('/api/categories');
      if (tab === 'orders') await renderOrders();
      else if (tab === 'products') await renderProducts();
      else if (tab === 'categories') renderCategories();
      else if (tab === 'settings') await renderSettings();
    } catch (e) {
      view.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  }

  // ---------- orders ----------
  async function renderOrders() {
    const [stats, orders] = await Promise.all([
      refreshBadge(),
      api(`/api/admin/orders${orderFilter ? `?status=${orderFilter}` : ''}`),
    ]);
    const filters = [['new', 'جديد'], ['confirmed', 'تم التأكيد'], ['shipped', 'تم الشحن'], ['delivered', 'تم التسليم'], ['cancelled', 'ملغي'], ['', 'الكل']];
    const storageMsg = {
      ok: '<div class="notice ok">✅ التخزين الدائم شغال: المنتجات والصور والطلبات محفوظة.</div>',
      missing: '<div class="error">⚠️ مفيش Volume متوصل بالموقع على Railway. أي منتجات أو طلبات هتتمسح مع أول تحديث. ضيف Volume على المسار /data.</div>',
      wrong_path: '<div class="error">⚠️ فيه Volume بس على مسار غلط. خلي الـ Mount Path بتاعه /data بالظبط.</div>',
    }[stats?.storage] || '';
    view.innerHTML = `
      ${storageMsg}
      ${stats ? `<div class="stats">
        <div class="stat"><small>طلبات جديدة</small><b>${stats.new_orders}</b></div>
        <div class="stat"><small>طلبات النهارده</small><b>${stats.orders_today}</b></div>
        <div class="stat"><small>إجمالي المبيعات (تم التسليم)</small><b>${money(stats.revenue)}</b></div>
        <div class="stat"><small>منتجات نفذت</small><b>${stats.out_of_stock}</b></div>
      </div>` : ''}
      <div class="toolbar">
        <h2>الطلبات</h2>
        <div class="filters">${filters.map(([k, l]) => `<button data-f="${k}" class="${k === orderFilter ? 'active' : ''}">${l}</button>`).join('')}</div>
      </div>
      ${orders.length ? orders.map(orderCard).join('') : '<div class="empty"><div class="big">📭</div><p>لا توجد طلبات هنا</p></div>'}`;

    const sig = signal();
    view.addEventListener('click', async (e) => {
      const f = e.target.closest('[data-f]');
      if (f) { orderFilter = f.dataset.f; renderOrders().catch(fail); return; }
      const del = e.target.closest('[data-del-order]');
      if (del && confirm('حذف الطلب نهائياً؟')) {
        try { await api(`/api/admin/orders/${del.dataset.delOrder}`, { method: 'DELETE' }); toast('تم الحذف'); renderOrders(); } catch (ex) { fail(ex); }
      }
    }, { signal: sig });
    view.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-status]');
      if (!sel) return;
      try {
        await send(`/api/admin/orders/${sel.dataset.status}`, 'PUT', { status: sel.value });
        toast('✓ تم تحديث حالة الطلب');
        renderOrders();
      } catch (ex) { fail(ex); }
    }, { signal: sig });
  }

  function orderCard(o) {
    const wa = `https://wa.me/${o.phone.replace(/^\+?2?0/, '20')}`;
    const date = new Date(`${o.created_at.replace(' ', 'T')}Z`).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    return `<article class="order-card">
      <header>
        <div><b>طلب #${o.id}</b> <span class="status ${o.status}">${STATUS[o.status]}</span> <span class="muted">${esc(date)}</span></div>
        <div class="row-actions">
          <select data-status="${o.id}" aria-label="حالة الطلب">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn sm ghost" data-del-order="${o.id}">حذف</button>
        </div>
      </header>
      <div class="order-meta">
        <div>👤 ${esc(o.customer_name)}</div>
        <div>📞 <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.phone2 ? ` / <a href="tel:${esc(o.phone2)}">${esc(o.phone2)}</a>` : ''} · <a href="${esc(wa)}" target="_blank" rel="noopener" style="color:#25d366;font-weight:700">واتساب</a></div>
        <div>📍 ${esc(o.governorate)} — ${esc(o.address)}</div>
        ${o.notes ? `<div>📝 ${esc(o.notes)}</div>` : ''}
      </div>
      <ul>${o.items.map((i) => `<li>${esc(i.name)}${i.option ? ` (${esc(i.option)})` : ''} × ${i.qty} — ${money(i.price * i.qty)}</li>`).join('')}</ul>
      <div>المنتجات: ${money(o.subtotal)} + الشحن: ${money(o.shipping)} = <b>${money(o.total)}</b></div>
    </article>`;
  }

  // ---------- products ----------
  async function renderProducts() {
    const products = await api('/api/admin/products');
    view.innerHTML = `
      <div class="toolbar"><h2>المنتجات (${products.length})</h2><button class="btn" id="newProduct">+ إضافة منتج</button></div>
      ${products.length ? `<div class="table-wrap"><table>
        <thead><tr><th></th><th>المنتج</th><th>القسم</th><th>السعر</th><th>المخزون</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${products.map((p) => `<tr>
          <td>${p.images[0] ? `<img class="mini" src="${esc(p.images[0])}" alt="">` : '<div class="mini"></div>'}</td>
          <td><b>${esc(p.name)}</b>${p.featured ? ' ⭐' : ''}${p.options.length ? `<div class="muted">${p.options.map(esc).join('، ')}</div>` : ''}</td>
          <td>${esc(p.category_name || '—')}</td>
          <td>${money(p.price)}${p.old_price ? `<div class="muted" style="text-decoration:line-through">${money(p.old_price)}</div>` : ''}</td>
          <td>${p.stock <= 0 ? '<span style="color:var(--danger);font-weight:700">نفذ</span>' : p.stock}</td>
          <td>${p.active ? 'ظاهر' : '<span class="muted">مخفي</span>'}</td>
          <td><div class="row-actions"><button class="btn sm ghost" data-edit="${p.id}">تعديل</button><button class="btn sm danger" data-del="${p.id}">حذف</button></div></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><div class="big">🛍️</div><p>لسه مفيش منتجات. اضغط "إضافة منتج" وابدأ.</p></div>'}`;

    view.addEventListener('click', async (e) => {
      if (e.target.closest('#newProduct')) return productForm();
      const ed = e.target.closest('[data-edit]');
      if (ed) return productForm(products.find((p) => p.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del && confirm('متأكد إنك عايز تحذف المنتج ده؟')) {
        try { await api(`/api/admin/products/${del.dataset.del}`, { method: 'DELETE' }); toast('تم حذف المنتج'); renderProducts(); } catch (ex) { fail(ex); }
      }
    }, { signal: signal() });
  }

  function productForm(p) {
    const isNew = !p;
    p = p || { name: '', description: '', price: '', old_price: '', category_id: categories[0]?.id || '', images: [], options: [], stock: 1, active: true, featured: false };
    let images = [...p.images];
    $('#dialogBody').innerHTML = `
      <form id="pForm">
        <h3>${isNew ? 'إضافة منتج جديد' : 'تعديل المنتج'}</h3>
        <div class="field"><label>الصور <span class="hint">(أول صورة هي الصورة الرئيسية)</span></label><div class="images" id="imgs"></div></div>
        <div class="form-grid">
          <div class="field full"><label for="p_name">اسم المنتج *</label><input type="text" id="p_name" name="name" required value="${esc(p.name)}"></div>
          <div class="field"><label for="p_price">السعر (ج.م) *</label><input type="number" id="p_price" name="price" min="0" step="any" required value="${esc(p.price)}"></div>
          <div class="field"><label for="p_old">السعر قبل الخصم <span class="hint">(اختياري)</span></label><input type="number" id="p_old" name="old_price" min="0" step="any" value="${esc(p.old_price ?? '')}"></div>
          <div class="field"><label for="p_cat">القسم</label><select id="p_cat" name="category_id"><option value="">بدون قسم</option>${categories.map((c) => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="p_stock">الكمية المتاحة</label><input type="number" id="p_stock" name="stock" min="0" step="1" value="${esc(p.stock)}"></div>
          <div class="field full"><label for="p_opts">الألوان / الموديلات <span class="hint">(افصل بينهم بفاصلة، مثال: بمبي, أزرق, أحمر — سيبها فاضية لو مفيش اختيارات)</span></label><input type="text" id="p_opts" name="options" value="${esc(p.options.join(', '))}"></div>
          <div class="field full"><label for="p_desc">الوصف</label><textarea id="p_desc" name="description" rows="4" placeholder="المقاس، الخامة، عدد الجيوب...">${esc(p.description)}</textarea></div>
        </div>
        <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> ظاهر في المتجر</label>
        <label class="check"><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''}> منتج مميز ⭐ (يظهر في الصفحة الرئيسية)</label>
        <div class="error" id="pError" hidden></div>
        <div class="dialog-actions"><button type="button" class="btn ghost" id="pCancel">إلغاء</button><button class="btn" id="pSave">حفظ</button></div>
      </form>`;

    const drawImages = () => {
      $('#imgs').innerHTML = images.map((u, i) => `<div class="img"><img src="${esc(u)}" alt=""><button type="button" data-rm="${i}" title="حذف">✕</button>${i ? `<button type="button" class="mk" data-main="${i}" title="اجعلها الرئيسية">★</button>` : '<span class="first">الرئيسية</span>'}</div>`).join('')
        + '<label class="upload-box">📷<br>إضافة صور<input type="file" accept="image/*" multiple id="fileInput"></label>';
    };
    drawImages();
    $('#imgs').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      const mk = e.target.closest('[data-main]');
      if (rm) { images.splice(Number(rm.dataset.rm), 1); drawImages(); }
      if (mk) { const [x] = images.splice(Number(mk.dataset.main), 1); images.unshift(x); drawImages(); }
    });
    $('#imgs').addEventListener('change', async (e) => {
      if (e.target.id !== 'fileInput' || !e.target.files.length) return;
      const fd = new FormData();
      for (const f of e.target.files) fd.append('images', f);
      $('.upload-box').innerHTML = 'جاري الرفع...';
      try {
        const r = await api('/api/admin/upload', { method: 'POST', body: fd });
        images.push(...r.urls);
      } catch (ex) { fail(ex); }
      drawImages();
    });

    $('#pCancel').addEventListener('click', () => dialog.close());
    $('#pForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        name: f.name.value,
        description: f.description.value,
        price: f.price.value,
        old_price: f.old_price.value,
        category_id: f.category_id.value || null,
        stock: f.stock.value,
        options: f.options.value,
        active: f.active.checked,
        featured: f.featured.checked,
        images,
      };
      $('#pSave').disabled = true;
      try {
        if (isNew) await send('/api/admin/products', 'POST', body);
        else await send(`/api/admin/products/${p.id}`, 'PUT', body);
        dialog.close();
        toast('✓ تم حفظ المنتج');
        renderProducts();
      } catch (ex) {
        $('#pError').textContent = ex.message;
        $('#pError').hidden = false;
        $('#pSave').disabled = false;
      }
    });
    dialog.showModal();
  }

  // ---------- categories ----------
  function renderCategories() {
    view.innerHTML = `
      <div class="toolbar"><h2>الأقسام</h2><button class="btn" id="newCat">+ إضافة قسم</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>الاسم</th><th>الرابط</th><th>الترتيب</th><th>عدد المنتجات الظاهرة</th><th></th></tr></thead>
        <tbody>${categories.map((c) => `<tr>
          <td><b>${esc(c.name)}</b></td><td class="muted" dir="ltr">${esc(c.slug)}</td><td>${c.sort}</td><td>${c.product_count}</td>
          <td><div class="row-actions"><button class="btn sm ghost" data-edit="${c.id}">تعديل</button><button class="btn sm danger" data-del="${c.id}">حذف</button></div></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    view.addEventListener('click', async (e) => {
      if (e.target.closest('#newCat')) return categoryForm();
      const ed = e.target.closest('[data-edit]');
      if (ed) return categoryForm(categories.find((c) => c.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del && confirm('حذف القسم؟ المنتجات اللي فيه هتفضل موجودة بس من غير قسم.')) {
        try { await api(`/api/admin/categories/${del.dataset.del}`, { method: 'DELETE' }); toast('تم حذف القسم'); render(); } catch (ex) { fail(ex); }
      }
    }, { signal: signal() });
  }

  function categoryForm(c) {
    const isNew = !c;
    c = c || { name: '', slug: '', sort: categories.length + 1 };
    $('#dialogBody').innerHTML = `
      <form id="cForm">
        <h3>${isNew ? 'إضافة قسم' : 'تعديل القسم'}</h3>
        <div class="field"><label for="c_name">اسم القسم *</label><input type="text" id="c_name" name="name" required value="${esc(c.name)}"></div>
        <div class="field"><label for="c_slug">الرابط بالإنجليزي <span class="hint">(مثال: lunch-bags — اختياري)</span></label><input type="text" id="c_slug" name="slug" dir="ltr" value="${esc(c.slug)}"></div>
        <div class="field"><label for="c_sort">الترتيب</label><input type="number" id="c_sort" name="sort" value="${esc(c.sort)}"></div>
        <div class="error" id="cError" hidden></div>
        <div class="dialog-actions"><button type="button" class="btn ghost" id="cCancel">إلغاء</button><button class="btn">حفظ</button></div>
      </form>`;
    $('#cCancel').addEventListener('click', () => dialog.close());
    $('#cForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, slug: f.slug.value, sort: f.sort.value };
      try {
        if (isNew) await send('/api/admin/categories', 'POST', body);
        else await send(`/api/admin/categories/${c.id}`, 'PUT', body);
        dialog.close();
        toast('✓ تم الحفظ');
        render();
      } catch (ex) {
        $('#cError').textContent = ex.message;
        $('#cError').hidden = false;
      }
    });
    dialog.showModal();
  }

  // ---------- settings ----------
  async function renderSettings() {
    const s = await api('/api/admin/settings');
    const field = (k, label, type = 'text', hint = '') => `<div class="field"><label for="s_${k}">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label><input type="${type}" id="s_${k}" name="${k}" value="${esc(s[k])}" ${type === 'number' ? 'min="0" step="any"' : ''}></div>`;
    view.innerHTML = `
      <div class="toolbar"><h2>الإعدادات</h2></div>
      <div class="settings-grid">
        <form class="panel" id="sForm">
          <h3 style="margin-top:0">بيانات المتجر</h3>
          ${field('store_name', 'اسم المتجر')}
          ${field('tagline', 'الوصف المختصر')}
          ${field('announcement', 'شريط الإعلان أعلى الموقع', 'text', '(سيبه فاضي لإخفائه)')}
          ${field('whatsapp', 'رقم الواتساب', 'tel', '(مثال: 01012345678)')}
          ${field('phone', 'رقم التليفون', 'tel')}
          ${field('facebook_url', 'رابط صفحة الفيسبوك', 'url')}
          <h3>الشحن</h3>
          ${field('shipping_fee', 'مصاريف الشحن (ج.م)', 'number')}
          ${field('free_shipping_over', 'شحن مجاني للطلبات فوق (ج.م)', 'number', '(0 = بدون شحن مجاني)')}
          <button class="btn">حفظ الإعدادات</button>
        </form>
        <form class="panel" id="pwForm">
          <h3 style="margin-top:0">تغيير كلمة السر</h3>
          <div class="field"><label for="pw_cur">كلمة السر الحالية</label><input type="password" id="pw_cur" name="current" required autocomplete="current-password"></div>
          <div class="field"><label for="pw_new">كلمة السر الجديدة</label><input type="password" id="pw_new" name="next" required minlength="6" autocomplete="new-password"></div>
          <button class="btn">تغيير كلمة السر</button>
        </form>
      </div>`;
    $('#sForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await send('/api/admin/settings', 'PUT', Object.fromEntries(new FormData(e.target))); toast('✓ تم حفظ الإعدادات'); } catch (ex) { fail(ex); }
    });
    $('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await send('/api/admin/password', 'PUT', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('✓ تم تغيير كلمة السر'); } catch (ex) { fail(ex); }
    });
  }

  async function start() {
    $('#login').hidden = true;
    $('#dash').hidden = false;
    render();
  }

  // Check for new orders every minute while the dashboard is open.
  setInterval(() => { if (!$('#dash').hidden) refreshBadge(); }, 60e3);

  api('/api/admin/me').then((r) => (r.admin ? start() : showLogin())).catch(showLogin);
})();
