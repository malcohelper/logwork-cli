// Keycloak HTML form parsing (login, password update, device choice, OTP) and
// form submission.
import { safeApiAuthError } from './api-auth-support.mjs';

export function findKeycloakAuthUrl(html, baseUrl) {
  const matches = String(html || '').match(/https:\/\/keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth[^"' <]+/i);
  if (matches?.[0]) {
    return decodeHtml(matches[0]);
  }

  const href = findAttributeValue(html, 'href', /keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth/i);
  if (href) {
    return new URL(decodeHtml(href), baseUrl).toString();
  }

  return null;
}

export function selectNextKeycloakForm(html, baseUrl, { preferDevice = false } = {}) {
  const forms = parseHtmlForms(html, baseUrl);
  const passwordUpdate = forms.find((form) => form.kind === 'password-update');
  const credentials = forms.find((form) => form.kind === 'credentials');
  const otp = forms.find((form) => form.kind === 'otp');
  const device = forms.find((form) => form.kind === 'device' || form.devices.length > 0);

  if (passwordUpdate) {
    return passwordUpdate;
  }
  if (credentials) {
    return credentials;
  }
  if (otp) {
    return otp;
  }
  if (preferDevice && device) {
    return {
      ...device,
      kind: 'device'
    };
  }
  if (device) {
    return device;
  }

  return forms.find((form) => form.kind === 'credentials')
    || null;
}

export function parseHtmlForms(html, baseUrl) {
  const forms = [];
  const source = String(html || '');
  const regex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = regex.exec(source))) {
    const attrs = match[1];
    const inner = match[2];
    const action = resolveActionUrl(decodeHtml(readAttr(attrs, 'action') || ''), baseUrl);
    const method = (readAttr(attrs, 'method') || 'GET').toUpperCase();
    const fields = readInputFields(inner);
    const devices = readDeviceOptions(inner);
    const kind = classifyForm(fields, devices);
    forms.push({ action, method, fields, devices, kind });
  }
  return forms;
}

export async function submitCredentialsForm(session, form, { email, password }) {
  const body = bodyFromForm(form);
  body.set(usernameFieldName(form) || 'username', email);
  body.set(passwordFieldName(form) || 'password', password);
  return postForm(session, form.action, body);
}

export async function submitPasswordUpdateForm(session, form, {
  newPassword,
  confirmPassword
}) {
  const fieldNames = passwordUpdateFieldNames(form);
  if (!fieldNames) {
    throw safeApiAuthError('Keycloak password update form did not contain the expected password fields.');
  }
  if (!newPassword || newPassword !== confirmPassword) {
    throw safeApiAuthError('New Resource Optimiser passwords must be non-empty and match.');
  }

  const body = bodyFromForm(form);
  body.set(fieldNames.newPassword, newPassword);
  body.set(fieldNames.confirmPassword, confirmPassword);
  return postForm(session, form.action, body);
}

export async function submitDeviceForm(session, form, device) {
  const body = bodyFromForm(form);
  body.set(device.name, device.value);
  return postForm(session, form.action, body);
}

export async function submitOtpForm(session, form, otp, selectedDevice = null) {
  const body = bodyFromForm(form);
  if (selectedDevice?.name && selectedDevice.value !== undefined) {
    body.set(selectedDevice.name, selectedDevice.value);
  }
  body.set(otpFieldName(form) || 'otp', otp);
  return postForm(session, form.action, body);
}

function postForm(session, action, body) {
  return session.request(action, {
    method: 'POST',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
}

export function readTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(decodeHtml(match[1])).slice(0, 120) : null;
}

export function readBodyHint(html) {
  const bodyMatch = String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = String(bodyMatch ? bodyMatch[1] : html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const hint = stripTags(decodeHtml(body)).slice(0, 160);
  return hint || null;
}

function resolveActionUrl(action, baseUrl) {
  if (!action) {
    return baseUrl ? new URL(baseUrl).toString() : '';
  }
  if (!baseUrl) {
    return action;
  }
  return new URL(action, baseUrl).toString();
}

function bodyFromForm(form) {
  const body = new URLSearchParams();
  for (const field of form.fields) {
    if (field.name && field.value !== undefined) {
      body.set(field.name, field.value);
    }
  }
  return body;
}

function classifyForm(fields, devices) {
  if (passwordUpdateFieldNames({ fields })) {
    return 'password-update';
  }
  if (passwordFieldName({ fields })) {
    return 'credentials';
  }
  if (otpFieldName({ fields })) {
    return 'otp';
  }
  if (devices.length > 0) {
    return 'device';
  }
  return 'unknown';
}

function readInputFields(html) {
  const fields = [];
  const regex = /<input\b([^>]*)>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const attrs = match[1];
    fields.push({
      name: decodeHtml(readAttr(attrs, 'name') || ''),
      id: decodeHtml(readAttr(attrs, 'id') || ''),
      type: decodeHtml(readAttr(attrs, 'type') || 'text'),
      value: decodeHtml(readAttr(attrs, 'value') || ''),
      autocomplete: decodeHtml(readAttr(attrs, 'autocomplete') || ''),
      inputmode: decodeHtml(readAttr(attrs, 'inputmode') || ''),
      placeholder: decodeHtml(readAttr(attrs, 'placeholder') || ''),
      ariaLabel: decodeHtml(readAttr(attrs, 'aria-label') || '')
    });
  }
  return fields.filter((field) => field.name);
}

function otpFieldName(form) {
  return form.fields.find(isOtpInputField)?.name;
}

function usernameFieldName(form) {
  return fieldName(form, ['username', 'email', 'login', 'user', 'userid', 'user_id']) ||
    form.fields.find((field) => isTextInputField(field) && fieldHint(field, /user|email|login|account|identifier/))?.name ||
    form.fields.find((field) => isTextInputField(field) && !isOtpInputField(field))?.name;
}

function passwordFieldName(form) {
  return fieldName(form, ['password', 'passwd', 'pass', 'pwd']) ||
    form.fields.find((field) => String(field.type || '').toLowerCase() === 'password')?.name;
}

function passwordUpdateFieldNames(form) {
  const passwordFields = form.fields.filter(
    (field) => String(field.type || '').toLowerCase() === 'password'
  );
  if (passwordFields.length < 2) {
    return null;
  }

  const newPassword = fieldName(form, [
    'password-new',
    'new-password',
    'newPassword',
    'passwordNew'
  ]) || passwordFields.find((field) => fieldHint(field, /(?:new.*password|password.*new)/i))?.name;
  const confirmPassword = fieldName(form, [
    'password-confirm',
    'confirm-password',
    'confirmPassword',
    'passwordConfirm',
    'password-repeat',
    'repeat-password'
  ]) || passwordFields.find((field) => fieldHint(field, /confirm|repeat/i))?.name;

  if (newPassword && confirmPassword && newPassword !== confirmPassword) {
    return { newPassword, confirmPassword };
  }

  return {
    newPassword: passwordFields[0].name,
    confirmPassword: passwordFields[1].name
  };
}

function fieldName(form, candidates) {
  const lower = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return form.fields.find((field) => lower.has(String(field.name || '').toLowerCase()))?.name;
}

function isTextInputField(field) {
  const type = String(field.type || 'text').toLowerCase();
  return ['text', 'email', 'search', 'tel', 'url', ''].includes(type);
}

function isOtpInputField(field) {
  const name = String(field.name || '').toLowerCase();
  const type = String(field.type || 'text').toLowerCase();
  if (['hidden', 'radio', 'checkbox', 'submit', 'button'].includes(type)) {
    return false;
  }

  if (/^(otp|totp|mfa|mfa_code|two_factor|twofactor|authenticator_code|authenticatorCode)$/i.test(name)) {
    return true;
  }

  if (/(otp|totp|mfa|2fa|two[_-]?factor|authenticator|verification)/i.test(name)) {
    return true;
  }

  if (name !== 'code') {
    return false;
  }

  return fieldHint(field, /otp|totp|one-time|one time|verification|authenticator|2fa|mfa|sms|pin|numeric|number/);
}

function fieldHint(field, pattern) {
  const hint = [
    field.id,
    field.autocomplete,
    field.inputmode,
    field.placeholder,
    field.ariaLabel
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return pattern.test(hint);
}

function readDeviceOptions(html) {
  const devices = [];
  const radioRegex = /<input\b([^>]*type=["']?radio["']?[^>]*)>/gi;
  let radioMatch;
  while ((radioMatch = radioRegex.exec(String(html || '')))) {
    const attrs = radioMatch[1];
    const name = decodeHtml(readAttr(attrs, 'name') || '');
    const value = decodeHtml(readAttr(attrs, 'value') || '');
    const id = decodeHtml(readAttr(attrs, 'id') || '');
    if (!name || !value) {
      continue;
    }
    devices.push({
      type: 'radio',
      name,
      value,
      label: readLabelFor(html, id) || readWrappingLabelForInput(html, attrs) || value
    });
  }

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;
  while ((selectMatch = selectRegex.exec(String(html || '')))) {
    const name = decodeHtml(readAttr(selectMatch[1], 'name') || '');
    if (!name) {
      continue;
    }
    const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionRegex.exec(selectMatch[2]))) {
      const value = decodeHtml(readAttr(optionMatch[1], 'value') || '');
      const label = stripTags(decodeHtml(optionMatch[2]));
      if (value) {
        devices.push({ type: 'select', name, value, label: label || value });
      }
    }
  }

  return devices;
}

function readLabelFor(html, id) {
  if (!id) {
    return null;
  }
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html || '').match(new RegExp(`<label\\b[^>]*for=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/label>`, 'i'));
  return match ? stripTags(decodeHtml(match[1])) : null;
}

function readWrappingLabelForInput(html, inputAttrs) {
  const inputValue = readAttr(inputAttrs, 'value');
  const labels = String(html || '').match(/<label\b[^>]*>[\s\S]*?<\/label>/gi) || [];
  for (const label of labels) {
    const inputMatch = label.match(/<input\b([^>]*)>/i);
    if (!inputMatch) {
      continue;
    }
    const labelInputValue = readAttr(inputMatch[1], 'value');
    const labelInputName = readAttr(inputMatch[1], 'name');
    if (
      inputValue !== null &&
      labelInputValue === inputValue &&
      labelInputName === readAttr(inputAttrs, 'name')
    ) {
      return stripTags(decodeHtml(label));
    }
  }
  return null;
}

export function summarizeFormShapes(forms) {
  return forms
    .slice(0, 3)
    .map((form, index) => {
      const fields = form.fields
        .slice(0, 8)
        .map((field) => `${field.name || '(unnamed)'}:${field.type || 'text'}`)
        .join(',');
      const devices = form.devices.length ? ` devices=${form.devices.length}` : '';
      return `form${index + 1}{kind=${form.kind || 'unknown'} fields=[${fields}]${devices}}`;
    })
    .join(' ');
}

function readAttr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function findAttributeValue(html, attr, pattern) {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (pattern.test(value)) {
      return value;
    }
  }
  return null;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
