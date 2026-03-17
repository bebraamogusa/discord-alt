import { S, V } from './state.js';
import { API, escHtml, fmtTime, showToast, daPrompt, t } from './utils.js';
import { getServer, selectChannel, renderChannelList } from './ui.js';

// ═══════════════════════════════════════════════════════
// POLLS — Render & Interact
// ═══════════════════════════════════════════════════════

export function renderPollHtml(msg) {
  const poll = msg.poll;
  if (!poll) return '';
  const expired = poll.expiry && poll.expiry < Math.floor(Date.now() / 1000);
  const totalVotes = poll.answers.reduce((s, a) => s + (a.count || 0), 0);
  const answersHtml = poll.answers.map(a => {
    const pct = totalVotes > 0 ? Math.round(((a.count || 0) / totalVotes) * 100) : 0;
    return `
      <div class="poll-answer ${a.me ? 'poll-voted' : ''} ${expired ? 'poll-expired' : ''}"
           data-msg-id="${escHtml(msg.id)}" data-answer-id="${a.id}" data-ch-id="${escHtml(msg.channel_id)}">
        <div class="poll-answer-bar" style="width:${pct}%"></div>
        <span class="poll-answer-text">${a.emoji ? escHtml(a.emoji) + ' ' : ''}${escHtml(a.text || '')}</span>
        <span class="poll-answer-count">${a.count || 0} (${pct}%)</span>
      </div>
    `;
  }).join('');

  const expiryText = expired ? '✅ Голосование завершено' :
    (poll.expiry ? `⏱ Завершится ${fmtTime(poll.expiry * 1000)}` : '');

  return `
    <div class="poll-container" data-msg-id="${escHtml(msg.id)}">
      <div class="poll-question">📊 ${escHtml(poll.question)}</div>
      <div class="poll-answers">${answersHtml}</div>
      <div class="poll-footer">
        <span class="poll-total">${totalVotes} голос${totalVotes === 1 ? '' : totalVotes > 1 && totalVotes < 5 ? 'а' : 'ов'}</span>
        <span class="poll-expiry">${expiryText}</span>
      </div>
    </div>
  `;
}

// Attach poll vote handlers (called within attachMsgHandlers)
export function attachPollHandlers(container) {
  container.querySelectorAll('.poll-answer:not(.poll-expired)').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const msgId = el.dataset.msgId;
      const answerId = el.dataset.answerId;
      const chId = el.dataset.chId;
      const isVoted = el.classList.contains('poll-voted');
      try {
        if (isVoted) {
          await API.del(`/api/channels/${chId}/polls/${msgId}/answers/${answerId}/@me`);
        } else {
          await API.put(`/api/channels/${chId}/polls/${msgId}/answers/${answerId}/@me`);
        }
      } catch (err) {
        showToast(err.body?.error || 'Ошибка голосования', 'error');
      }
    };
  });
}

// ═══════════════════════════════════════════════════════
// POLLS — Creation
// ═══════════════════════════════════════════════════════

let _pollAnswers = [];

export function openPollCreator() {
  _pollAnswers = ['', ''];
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'modal-create-poll';
  modal.innerHTML = `
    <div class="modal modal-sm">
      <div class="modal-header">
        <h3>📊 Создать опрос</h3>
        <button class="modal-close" id="poll-modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Вопрос</label>
          <input id="poll-question" type="text" placeholder="Задайте вопрос..." maxlength="300">
        </div>
        <div class="form-group">
          <label>Варианты ответов</label>
          <div id="poll-answers-list"></div>
          <button class="btn btn-outline" id="poll-add-answer" style="margin-top:8px">+ Добавить вариант</button>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="poll-multiselect">
          <label for="poll-multiselect" style="margin:0">Множественный выбор</label>
        </div>
        <div class="form-group">
          <label>Длительность (часы)</label>
          <input id="poll-duration" type="number" value="24" min="1" max="720" style="width:100px">
        </div>
        <div class="auth-error" id="poll-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="poll-cancel">Отмена</button>
        <button class="btn btn-primary" id="poll-submit">Создать опрос</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderPollAnswerInputs();

  document.getElementById('poll-modal-close').onclick = () => modal.remove();
  document.getElementById('poll-cancel').onclick = () => modal.remove();
  document.getElementById('poll-add-answer').onclick = () => {
    if (_pollAnswers.length >= 10) return;
    _pollAnswers.push('');
    renderPollAnswerInputs();
  };

  document.getElementById('poll-submit').onclick = async () => {
    const question = document.getElementById('poll-question').value.trim();
    if (!question) { document.getElementById('poll-error').textContent = 'Введите вопрос'; return; }
    const answers = _pollAnswers.map(a => a.trim()).filter(a => a);
    if (answers.length < 2) { document.getElementById('poll-error').textContent = 'Минимум 2 варианта'; return; }
    const multiselect = document.getElementById('poll-multiselect').checked;
    const duration = parseInt(document.getElementById('poll-duration').value) || 24;

    try {
      await API.post(`/api/channels/${S.activeChannelId}/messages`, {
        content: '',
        poll: {
          question,
          answers: answers.map((text, i) => ({ id: i + 1, text })),
          allow_multiselect: multiselect,
          duration_hours: duration,
        },
      });
      modal.remove();
    } catch (err) {
      document.getElementById('poll-error').textContent = err.body?.error || 'Ошибка создания опроса';
    }
  };

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

function renderPollAnswerInputs() {
  const list = document.getElementById('poll-answers-list');
  if (!list) return;
  list.innerHTML = _pollAnswers.map((val, i) => `
    <div class="poll-answer-input" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
      <input type="text" class="poll-answer-field" data-idx="${i}" value="${escHtml(val)}" placeholder="Вариант ${i + 1}" maxlength="55" style="flex:1">
      ${_pollAnswers.length > 2 ? `<button class="btn-icon-sm poll-remove-answer" data-idx="${i}" title="Удалить">✕</button>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.poll-answer-field').forEach(inp => {
    inp.oninput = () => { _pollAnswers[parseInt(inp.dataset.idx)] = inp.value; };
  });
  list.querySelectorAll('.poll-remove-answer').forEach(btn => {
    btn.onclick = () => {
      _pollAnswers.splice(parseInt(btn.dataset.idx), 1);
      renderPollAnswerInputs();
    };
  });
}

// ═══════════════════════════════════════════════════════
// THREADS — Create from message
// ═══════════════════════════════════════════════════════

export async function createThread(channelId, messageId) {
  const name = await daPrompt('Название ветки', { title: 'Создать ветку', placeholder: 'Новая ветка', confirmText: 'Создать' });
  if (!name) return;
  try {
    const thread = await API.post(`/api/v1/channels/${channelId}/messages/${messageId}/threads`, { name: name.trim() });
    showToast('Ветка создана!', 'success');
    // Switch to thread channel
    if (thread && thread.id) {
      const srv = getServer(S.activeServerId);
      if (srv) {
        if (!srv.channels.find(c => c.id === thread.id)) {
          srv.channels.push({
            id: thread.id, name: thread.name || name, type: 'text',
            server_id: srv.id, guild_id: srv.id, category_id: null, parent_id: channelId, position: 999
          });
        }
        renderChannelList();
        selectChannel(thread.id);
      }
    }
  } catch (err) {
    showToast(err.body?.error || 'Ошибка создания ветки', 'error');
  }
}

// ═══════════════════════════════════════════════════════
// Socket handlers for polls
// ═══════════════════════════════════════════════════════

export function handlePollSocketEvents() {
  if (!window.socket) return;
  window.socket.on('poll:vote_add', (data) => updatePollInMessage(data));
  window.socket.on('poll:vote_remove', (data) => updatePollInMessage(data));
}

function updatePollInMessage(data) {
  const { message_id, poll } = data;
  // Update data model
  for (const [chId, msgs] of Object.entries(S.messages)) {
    const msg = msgs.find(m => m.id === message_id);
    if (msg) {
      msg.poll = poll;
      break;
    }
  }
  // Re-render poll in DOM
  const pollContainer = document.querySelector(`.poll-container[data-msg-id="${message_id}"]`);
  if (pollContainer) {
    const msg = { id: message_id, channel_id: S.activeChannelId, poll };
    pollContainer.outerHTML = renderPollHtml(msg);
    const parent = document.getElementById('messages-container');
    if (parent) attachPollHandlers(parent);
  }
}
