const state = { view: 'find', jobId: null, poll: null, pollInFlight: false, cancelling: false, pages: { saved: 1, discarded: 1, history: 1 }, loading: {} };
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const terminalStates = new Set(['completed', 'failed', 'cancelled']);

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function safeMessage(message = '') { return /temporarily unavailable|too many/i.test(message) ? message : 'Something went wrong. Please try again.'; }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3200); }
function empty(title, text) { return `<div class="empty"><b>${escape(title)}</b><span>${escape(text)}</span></div>`; }
function loading(text) { return `<div class="empty loading-state"><span class="spinner" aria-hidden="true"></span><b>${escape(text)}</b><span>Please wait a moment.</span></div>`; }
function plural(count, word = 'lead') { return `${count} ${word}${count === 1 ? '' : 's'}`; }

function setDiscoveryRunning(running) {
  const fields = $('#discovery-fields'); const submit = $('#find-leads-button');
  fields.disabled = running; submit.disabled = running;
  submit.textContent = running ? 'Searching…' : 'Find leads';
  $('#discovery-form').classList.toggle('is-locked', running);
  $('#form-lock-note').textContent = running ? 'Discovery is active. Search details will be available when it finishes.' : 'Results exclude businesses already discovered, saved, or marked not useful.';
}
function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = null; state.pollInFlight = false; }
function setProgress(job) {
  const requested = Number(job.requested) || 0; const found = Number(job.found) || 0;
  const percentage = requested ? Math.min(100, Math.round((found / requested) * 100)) : 0;
  $('#requested-count').textContent = requested; $('#found-count').textContent = found; $('#duplicate-count').textContent = Number(job.duplicates) || 0; $('#rejected-count').textContent = Number(job.rejected) || 0;
  $('#progress-percent').textContent = `${percentage}%`; $('#progress-fill').style.width = `${percentage}%`;
  $('.progress-track').setAttribute('aria-valuenow', String(percentage)); $('#progress-count').textContent = `${found} of ${requested} requested leads found`;
  const queued = job.status === 'queued';
  $('#progress-eyebrow').textContent = job.status === 'completed' ? 'Discovery complete' : job.status === 'failed' ? 'Discovery failed' : job.status === 'cancelled' ? 'Search cancelled' : 'Discovery in progress';
  $('#progress-title').textContent = job.status === 'completed' ? 'Discovery complete' : job.status === 'failed' ? 'Discovery failed' : job.status === 'cancelled' ? 'Search cancelled' : queued ? 'Preparing your search…' : 'Finding new leads…';
  $('#progress-message').textContent = job.status === 'completed' ? (found ? `Found ${plural(found, 'new usable lead')}.` : 'No new usable leads were found for this search.') : job.status === 'failed' ? safeMessage(job.error) : job.status === 'cancelled' ? 'This discovery search was cancelled.' : queued ? 'Preparing public sources and business checks…' : 'Searching public sources and checking businesses…';
  $('#progress-spinner').hidden = terminalStates.has(job.status); $('#cancel-job').hidden = terminalStates.has(job.status);
}
function searchingResults() { $('#new-results').innerHTML = loading('Searching for businesses…'); $('#results-summary').textContent = 'Discovery is active. New usable leads will appear when the search completes.'; }

function setView(view) {
  if (!['find', 'saved', 'discarded', 'history'].includes(view)) view = 'find';
  state.view = view; document.querySelectorAll('.view').forEach(element => { element.hidden = element.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  $('#mobile-nav').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  if (view === 'saved' || view === 'discarded') loadLeads(view); if (view === 'history') loadHistory();
}
function leadRows(items, view) {
  return `<table class="lead-table"><thead><tr><th>Business</th><th>Website</th><th>Email</th><th>Phone</th><th>Actions</th></tr></thead><tbody>${items.map(lead => `<tr><td class="business" data-label="Business">${escape(lead.businessName)}</td><td data-label="Website"><a class="link" rel="noopener noreferrer" target="_blank" href="${escape(lead.website)}">${escape(lead.domain)}</a></td><td data-label="Email"><a class="link" href="mailto:${escape(lead.email)}">${escape(lead.email)}</a></td><td data-label="Phone">${lead.phone ? `<a class="link" href="tel:${escape(lead.phone)}">${escape(lead.phone)}</a>` : '—'}</td><td data-label="Actions"><div class="actions">${view === 'new' ? `<button class="button secondary" data-status="saved" data-id="${lead._id}">Save</button><button class="button secondary danger" data-status="discarded" data-id="${lead._id}">Not useful</button>` : `<button class="button secondary" data-status="new" data-id="${lead._id}">Restore</button>`}</div></td></tr>`).join('')}</tbody></table>`;
}
function pager(data, view) { const page = data.pagination; if (page.pages < 2) return ''; return `<div class="pagination"><button class="button secondary" data-page="${page.page - 1}" data-page-view="${view}" ${page.page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${page.page} of ${page.pages}</span><button class="button secondary" data-page="${page.page + 1}" data-page-view="${view}" ${page.page === page.pages ? 'disabled' : ''}>Next</button></div>`; }
async function loadLeads(view = 'new') {
  const target = view === 'new' ? '#new-results' : `#${view}-results`; const search = view === 'new' ? '' : $(`#${view}-search`).value.trim();
  if (state.loading[view]) return; state.loading[view] = true;
  if (view !== 'new') $(target).innerHTML = loading('Loading leads…');
  try {
    const data = await api(`/api/leads?status=${view === 'discarded' ? 'discarded' : view}&page=${state.pages[view] || 1}&limit=25&search=${encodeURIComponent(search)}`);
    if (view !== 'new') $(`#${view}-count`).textContent = plural(data.pagination.total);
    const titles = { new: ['No new usable leads yet', 'Run a discovery search to begin.'], saved: ['No saved leads yet', "Save useful businesses from Find Leads and they'll appear here."], discarded: ['No excluded leads', 'Businesses you mark as Not Useful will appear here.'] };
    $(target).innerHTML = data.items.length ? leadRows(data.items, view) + pager(data, view) : empty(...titles[view]);
  } catch { $(target).innerHTML = empty('Unable to load leads', 'Please try again in a moment.'); } finally { state.loading[view] = false; }
}
async function loadHistory() {
  if (state.loading.history) return; state.loading.history = true; $('#history-results').innerHTML = loading('Loading search history…');
  try { const data = await api(`/api/search-history?page=${state.pages.history}&limit=25`); $('#history-results').innerHTML = data.items.length ? `<table class="history-table"><thead><tr><th>Category</th><th>Location</th><th>Keywords</th><th>Requested</th><th>Found</th><th>Date</th></tr></thead><tbody>${data.items.map(item => `<tr><td data-label="Category" class="business">${escape(item.category)}</td><td data-label="Location">${escape(item.location)}</td><td data-label="Keywords">${escape(item.keywords || '—')}</td><td data-label="Requested"><span class="count-chip neutral">${plural(item.requestedCount, 'requested')}</span></td><td data-label="Found"><span class="count-chip">${plural(item.foundCount)}</span></td><td data-label="Date">${new Date(item.createdAt).toLocaleDateString()}</td></tr>`).join('')}</tbody></table>` + pager(data, 'history') : empty('No searches yet', 'Completed discovery requests will appear here.'); } catch { $('#history-results').innerHTML = empty('Unable to load history', 'Please try again in a moment.'); } finally { state.loading.history = false; }
}
async function finishJob(job) {
  stopPolling(); state.jobId = null; state.cancelling = false; setDiscoveryRunning(false); setProgress(job);
  if (job.status === 'completed') { await loadLeads('new'); $('#results-summary').textContent = job.found ? `Found ${plural(job.found, 'new usable lead')}. Only businesses meeting the website and public email requirement are included.` : 'No new usable leads were found for this search.'; toast(job.found ? `✓ ${plural(job.found, 'new lead')} found` : '✓ Discovery complete'); }
  else if (job.status === 'cancelled') { $('#results-summary').textContent = 'Search cancelled. Adjust your details and try again when ready.'; toast('Search cancelled'); }
  else { $('#results-summary').textContent = 'Discovery could not be completed. Update your search and try again.'; toast(safeMessage(job.error)); }
}
async function poll() {
  if (!state.jobId || state.pollInFlight) return; state.pollInFlight = true; const jobId = state.jobId;
  try { const job = await api(`/api/discovery/jobs/${jobId}`); if (state.jobId !== jobId) return; setProgress(job); if (terminalStates.has(job.status)) await finishJob(job); } catch { if (state.jobId === jobId) { stopPolling(); state.jobId = null; state.cancelling = false; setDiscoveryRunning(false); $('#job-progress').hidden = false; setProgress({ status: 'failed', requested: 0, found: 0, duplicates: 0, rejected: 0 }); toast('Something went wrong. Please try again.'); } } finally { state.pollInFlight = false; }
}
$('#discovery-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.jobId) return;
  const form = event.currentTarget; const data = new FormData(form); setDiscoveryRunning(true); $('#job-progress').hidden = false; setProgress({ requested: Number(data.get('requestedCount')), found: 0, duplicates: 0, rejected: 0, status: 'queued' }); searchingResults();
  try { const job = await api('/api/discovery/jobs', { method: 'POST', body: JSON.stringify(Object.fromEntries(data)) }); state.jobId = job.jobId; toast('Search started'); await poll(); if (state.jobId) state.poll = setInterval(poll, 2500); } catch (error) { setDiscoveryRunning(false); $('#job-progress').hidden = true; $('#results-summary').textContent = 'Enter a niche and location to discover new businesses.'; toast(safeMessage(error.message)); }
});
$('#cancel-job').addEventListener('click', async () => { if (!state.jobId || state.cancelling) return; state.cancelling = true; const button = $('#cancel-job'); button.disabled = true; button.textContent = 'Cancelling…'; try { await api(`/api/discovery/jobs/${state.jobId}/cancel`, { method: 'POST' }); await poll(); } catch { toast('Something went wrong. Please try again.'); } finally { if (state.jobId) { state.cancelling = false; button.disabled = false; button.textContent = 'Cancel search'; } } });
document.addEventListener('submit', event => { const form = event.target.closest('[data-search-form]'); if (!form) return; event.preventDefault(); const view = form.dataset.searchForm; if (state.loading[view]) return; state.pages[view] = 1; loadLeads(view); });
document.addEventListener('click', async event => {
  const navigation = event.target.closest('[data-view]'); if (navigation) { event.preventDefault(); location.hash = navigation.dataset.view; setView(navigation.dataset.view); return; }
  const action = event.target.closest('[data-status]'); if (action) { if (action.disabled) return; const initial = action.textContent; action.disabled = true; action.textContent = action.dataset.status === 'saved' ? 'Saving…' : 'Updating…'; try { await api(`/api/leads/${action.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: action.dataset.status }) }); toast(action.dataset.status === 'saved' ? '✓ Lead saved' : action.dataset.status === 'discarded' ? '✓ Lead moved to Not Useful' : '✓ Lead restored'); await loadLeads(state.view); if (state.view === 'find') await loadLeads('new'); } catch { action.disabled = false; action.textContent = initial; toast('Something went wrong. Please try again.'); } return; }
  const page = event.target.closest('[data-page-view]'); if (page && !page.disabled) { state.pages[page.dataset.pageView] = Number(page.dataset.page); page.dataset.pageView === 'history' ? loadHistory() : loadLeads(page.dataset.pageView); }
});
$('#menu-toggle').addEventListener('click', event => { const navigation = $('#mobile-nav'); navigation.classList.toggle('open'); event.currentTarget.setAttribute('aria-expanded', String(navigation.classList.contains('open'))); });
window.addEventListener('hashchange', () => setView(location.hash.slice(1) || 'find'));
setView(location.hash.slice(1) || 'find');
