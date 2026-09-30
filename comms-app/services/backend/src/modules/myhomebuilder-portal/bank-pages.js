// The admin Banking page: transactions to file, each with a suggestion and a File to list (one
// click with scripts: choosing files it), recently filed ones, and the bank accounts (linked
// through Stripe, or statements uploaded). bank.js decides what it shows.
import { dateText, escapeAttribute, pageShell } from "./pages.js";
import { escapeHtml, money } from "./format.js";

const BILLING_SCRIPT = "/clients/portal/billing.js";
const SHOWN = 100;

function notice(status) {
  if (!status) return "";
  const link = status.link ? ` <a class="portal-inline-link" href="${escapeAttribute(status.link)}" target="_blank" rel="noopener">Open Stripe's Financial Connections settings</a>` : "";
  return `<p class="${status.tone === "error" ? "portal-error" : "portal-notice"}" role="status">${escapeHtml(status.text)}${link}</p>`;
}

function options(groups, selected = "") {
  return `<option value="">File to…</option>${groups.map((group) => `<optgroup label="${escapeAttribute(group.label)}">${group.options.map(([value, name]) => `<option value="${escapeAttribute(value)}"${value === selected ? " selected" : ""}>${escapeHtml(group.label !== "Common" && group.label !== "Pay crew" && group.label !== "Overhead" ? name.replace(`${group.label} · `, "") : name)}</option>`).join("")}</optgroup>`).join("")}`;
}

function amountCell(txn) {
  const out = txn.amountCents < 0;
  return `<td class="books-money bank-amount ${out ? "bank-out" : "bank-in"}" data-label="Amount">${out ? "−" : "+"}${money(Math.abs(txn.amountCents))}</td>`;
}

function accountLabel(accounts, id) {
  const account = accounts.find((entry) => entry.id === id);
  return account ? `${account.name}${account.last4 ? ` ••${account.last4}` : ""}` : "";
}

function toFileRows(toFile, { accounts, suggestions, groupsFor }) {
  if (!toFile.length) return '<p class="portal-empty">Nothing to file. New transactions appear here as the bank sends them.</p>';
  const rows = toFile.slice(0, SHOWN).map((txn) => {
    const path = `/clients/admin/bank/transactions/${encodeURIComponent(txn.id)}/file`;
    const suggestion = suggestions.get(txn.id);
    return `<tr id="txn-${escapeAttribute(txn.id)}">
          <td class="bank-check"><input type="checkbox" name="ids" value="${escapeAttribute(txn.id)}" form="bank-bulk" aria-label="Check ${escapeAttribute(txn.description)}"></td>
          <td data-label="Date">${dateText(txn.postedOn)}${txn.status === "pending" ? '<small>Pending</small>' : ""}</td>
          <td data-label="Transaction">${escapeHtml(txn.description)}<small>${escapeHtml(accountLabel(accounts, txn.accountId))}</small></td>
          ${amountCell(txn)}
          <td class="bank-suggest-cell" data-label="Suggested">${suggestion ? `<form method="post" action="${path}">
              <input type="hidden" name="target" value="${escapeAttribute(suggestion.target)}">
              <button class="bank-suggest" type="submit" title="File to ${escapeAttribute(suggestion.name)}">${escapeHtml(suggestion.name)}</button>
            </form>` : ""}</td>
          <td class="bank-file-cell" data-label="File to">
            <form class="bank-file" method="post" action="${path}">
              <select name="target" data-autofile aria-label="File ${escapeAttribute(txn.description)} to">${options(groupsFor(txn.amountCents))}</select>
              <button class="portal-logout-button" type="submit" data-autofile-button>File</button>
            </form>
          </td>
        </tr>`;
  }).join("");
  return `<form class="bank-bulk" id="bank-bulk" method="post" action="/clients/admin/bank/file">
          <label class="bank-check-all" hidden><input type="checkbox" data-check-all> Check all</label>
          <label for="bank-bulk-target" class="bank-bulk-label">File the checked ones to
            <select id="bank-bulk-target" name="target">${options(groupsFor(null))}</select>
          </label>
          <button class="button button-solid" type="submit">File checked</button>
        </form>
        <table class="portal-table books-table bank-table">
          <thead><tr><th scope="col"><span class="visually-hidden">Check</span></th><th scope="col">Date</th><th scope="col">Transaction</th><th scope="col" class="books-money">Amount</th><th scope="col">Suggested</th><th scope="col">File to</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${toFile.length > SHOWN ? `<p class="admin-meta">Showing the newest ${SHOWN} of ${toFile.length}. File these to see the rest.</p>` : ""}`;
}

function filedRows(filed, { accounts }) {
  if (!filed.length) return '<p class="portal-empty">Nothing filed yet.</p>';
  const rows = filed.map((txn) => `<tr>
          <td data-label="Date">${dateText(txn.postedOn)}${txn.status === "pending" ? "<small>Pending: posts to the books once the bank posts it</small>" : txn.status === "void" ? "<small>Voided by the bank</small>" : ""}</td>
          <td data-label="Transaction">${escapeHtml(txn.description)}<small>${escapeHtml(accountLabel(accounts, txn.accountId))}</small></td>
          ${amountCell(txn)}
          <td data-label="Filed to">${escapeHtml(txn.filed?.name || "")}</td>
          <td class="portal-actions">
            <form method="post" action="/clients/admin/bank/transactions/${encodeURIComponent(txn.id)}/file">
              <input type="hidden" name="target" value="">
              <button class="portal-logout-button" type="submit">Unfile</button>
            </form>
          </td>
        </tr>`).join("");
  return `<table class="portal-table books-table bank-table bank-filed">
          <thead><tr><th scope="col">Date</th><th scope="col">Transaction</th><th scope="col" class="books-money">Amount</th><th scope="col">Filed to</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
}

function accountCards(accounts, counts) {
  return accounts.map((account) => {
    const count = counts.get(account.id) || { total: 0, unfiled: 0 };
    const base = `/clients/admin/bank/accounts/${encodeURIComponent(account.id)}`;
    const stripe = account.source === "stripe";
    const active = account.status === "active";
    return `<section class="admin-card bank-account">
          <h2>${escapeHtml(account.name)}${account.last4 ? ` ••${escapeHtml(account.last4)}` : ""}</h2>
          <p class="admin-meta">${escapeHtml([account.institution, stripe ? (active ? "Linked through Stripe" : "Disconnected from Stripe") : "Statement uploads", `books account ${account.ledger}`].filter(Boolean).join(" · "))}</p>
          <p class="admin-meta">${count.total} transaction${count.total === 1 ? "" : "s"}, ${count.unfiled} to file${account.lastImportAt ? ` · updated ${dateText(account.lastImportAt)}` : ""}</p>
          ${account.lastImportError ? `<p class="portal-error">Stripe: ${escapeHtml(account.lastImportError)}</p>` : ""}
          ${stripe && active ? `<div class="admin-manage">
            <form method="post" action="${base}/refresh"><button class="button button-solid button-small" type="submit">Refresh</button></form>
            <form method="post" action="${base}/disconnect"><button class="portal-logout-button" type="submit">Disconnect</button></form>
          </div>
          <p class="portal-security-note">Disconnecting stops new transactions. Those already here stay in the books.</p>` : ""}
        </section>`;
  }).join("");
}

function linkCard({ stripeReady, settingsUrl }) {
  return `<section class="admin-card">
          <h2>Link a bank account</h2>
          <p class="admin-meta">Sign in to your bank on Stripe's secure page. Stripe then shares the account's transactions (dates, amounts and descriptions) here about once a day, up to 180 days back. They are used only to keep My Home Builder's books, and are never sold or shared. The portal never sees your bank sign-in.</p>
          ${stripeReady
            ? '<form method="post" action="/clients/admin/bank/link"><button class="button button-solid" type="submit">Link with Stripe</button></form>'
            : '<p class="portal-error">Stripe is not set up for the portal yet. Upload a statement instead.</p>'}
          <p class="portal-security-note">Stripe has to approve Financial Connections for your Stripe account first: <a class="portal-inline-link" href="${escapeAttribute(settingsUrl)}" target="_blank" rel="noopener">Financial Connections settings</a>.</p>
        </section>`;
}

function uploadCard(accounts) {
  const statementAccounts = accounts.filter((account) => account.source === "statement");
  return `<section class="admin-card">
          <h2>Upload a statement</h2>
          <form class="admin-stack-form" method="post" action="/clients/admin/bank/upload" enctype="multipart/form-data">
            <p class="admin-meta">The CSV, OFX or QFX download from your bank's website. Transactions already here are skipped, so overlapping statements are fine.</p>
            <label for="statement-file">Statement file
              <input id="statement-file" name="file" type="file" required accept=".csv,.ofx,.qfx,text/csv">
            </label>
            <label for="statement-account">Account
              <select id="statement-account" name="account">
                ${statementAccounts.map((account) => `<option value="${escapeAttribute(account.id)}">${escapeHtml(account.name)}${account.last4 ? ` ••${escapeHtml(account.last4)}` : ""}</option>`).join("")}
                <option value="new"${statementAccounts.length ? "" : " selected"}>A new account</option>
              </select>
            </label>
            <label for="statement-name">New account's name
              <input id="statement-name" name="name" type="text" maxlength="60" placeholder="Business checking">
            </label>
            <label for="statement-kind">New account's kind
              <select id="statement-kind" name="kind"><option value="cash">Checking or savings</option><option value="credit">Credit card</option></select>
            </label>
            <fieldset class="form-choice">
              <legend>In this file, money out is</legend>
              <label class="portal-check" for="sign-negative"><input id="sign-negative" name="sign" type="radio" value="out-negative" checked><span>A negative amount (most banks)</span></label>
              <label class="portal-check" for="sign-positive"><input id="sign-positive" name="sign" type="radio" value="out-positive"><span>A positive amount (some credit cards)</span></label>
            </fieldset>
            <button class="button button-solid" type="submit">Upload statement</button>
          </form>
        </section>`;
}

export function adminBankPage({ accounts, toFile, filed, suggestions, counts, groupsFor, stripeReady, status = null, settingsUrl }) {
  const setup = `<div class="admin-grid bank-accounts">
        ${accountCards(accounts, counts)}
        ${linkCard({ stripeReady, settingsUrl })}
        ${uploadCard(accounts)}
      </div>`;
  return pageShell(`<div class="site-width portal-shell books">
      <section class="admin-intro">
        <p class="portal-kicker">Admin panel</p>
        <h1 class="portal-heading">Banking.</h1>
        <p class="portal-lead">The business bank account's transactions, filed with one click to a job's costs, an overhead category or what they were. Filed transactions go straight into the books.</p>
        ${notice(status)}
      </section>
      ${accounts.length ? "" : `<section class="books-section" aria-labelledby="bank-start-heading">
        <div class="books-section-head"><h2 id="bank-start-heading">Start here</h2></div>
        ${setup}
      </section>`}
      <section class="books-section" aria-labelledby="bank-to-file-heading">
        <div class="books-section-head">
          <h2 id="bank-to-file-heading">To file${toFile.length ? ` (${toFile.length})` : ""}</h2>
        </div>
        <p class="admin-meta">Click a suggestion, or choose where it goes from its File to list. Money out to a job is that job's cost; crew work of the same amount can be paid from here.</p>
        ${toFileRows(toFile, { accounts, suggestions, groupsFor })}
      </section>
      <section class="books-section" aria-labelledby="bank-filed-heading">
        <div class="books-section-head">
          <h2 id="bank-filed-heading">Filed recently</h2>
          <a class="portal-secondary-link" href="/clients/admin/books">Books</a>
        </div>
        ${filedRows(filed, { accounts })}
      </section>
      ${accounts.length ? `<section class="books-section" aria-labelledby="bank-accounts-heading">
        <div class="books-section-head"><h2 id="bank-accounts-heading">Bank accounts</h2></div>
        ${setup}
      </section>` : ""}
    </div>`, { admin: true, bodyClass: "portal-page portal-admin", title: "Banking", scripts: [BILLING_SCRIPT] });
}
