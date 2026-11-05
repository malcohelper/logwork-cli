import React from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { SelectionList } from './manual-ink-ui.mjs';
import {
  nextIndex,
  previousIndex
} from './list-navigation.mjs';

const h = React.createElement;

export function AuthPrompt({
  prompt,
  inputValue = '',
  onInputChange,
  onPromptChange,
  onResolve,
  onReject
}) {
  if (!prompt) {
    return null;
  }

  if (prompt.step === 'credentials') {
    return h(AuthCredentialsPrompt, {
      prompt,
      inputValue,
      onInputChange,
      onPromptChange,
      onResolve,
      onReject
    });
  }

  if (prompt.step === 'password-update') {
    return h(AuthPasswordUpdatePrompt, {
      prompt,
      inputValue,
      onInputChange,
      onPromptChange,
      onResolve,
      onReject
    });
  }

  if (prompt.step === 'device') {
    return h(AuthDevicePrompt, {
      prompt,
      onPromptChange,
      onResolve,
      onReject
    });
  }

  if (prompt.step === 'otp') {
    return h(AuthOtpPrompt, {
      prompt,
      inputValue,
      onInputChange,
      onResolve,
      onReject
    });
  }

  return h(Box, {
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1
  }, h(Text, { color: 'cyan' }, 'Authenticating Resource Optimiser...'));
}

export function AuthCredentialsPrompt({
  prompt,
  inputValue = '',
  onInputChange,
  onPromptChange,
  onResolve,
  onReject
}) {
  useInput((input, key) => {
    if (key.escape) {
      onReject(new Error('Resource Optimiser authentication cancelled.'));
    }
  });

  const field = prompt.field || 'email';
  const isPassword = field === 'password';
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1
  },
  h(Text, { color: 'cyan' }, 'Resource Optimiser authentication'),
  h(Text, { color: 'gray' }, 'Secrets stay in memory and are not parsed as commands. Esc cancels.'),
  h(Box, null,
    h(Text, { color: 'cyan' }, isPassword ? 'password › ' : 'email › '),
    h(TextInput, {
      value: inputValue,
      onChange: onInputChange,
      mask: isPassword ? '•' : undefined,
      placeholder: isPassword ? 'Resource Optimiser password' : 'name@example.com',
      onSubmit(value) {
        const nextValue = String(value || '').trim();
        if (!nextValue) {
          return;
        }
        if (!isPassword) {
          onPromptChange({
            ...prompt,
            field: 'password',
            email: nextValue
          });
          onInputChange('');
          return;
        }
        onResolve({
          email: prompt.email,
          password: String(value || '')
        });
      }
    })));
}

export function AuthPasswordUpdatePrompt({
  prompt,
  inputValue = '',
  onInputChange,
  onPromptChange,
  onResolve,
  onReject
}) {
  useInput((input, key) => {
    if (key.escape) {
      onReject(new Error('Resource Optimiser authentication cancelled.'));
    }
  });

  const isConfirmation = prompt.field === 'confirmPassword';
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1
  },
  h(Text, { color: 'cyan' }, 'Update Resource Optimiser password'),
  h(Text, { color: 'gray' }, 'Keycloak requires this change to activate the account. Esc cancels.'),
  prompt.error ? h(Text, { color: 'red' }, prompt.error) : null,
  h(Box, null,
    h(Text, { color: 'cyan' }, isConfirmation ? 'confirm › ' : 'new password › '),
    h(TextInput, {
      value: inputValue,
      onChange: onInputChange,
      mask: '•',
      placeholder: isConfirmation ? 'Confirm new password' : 'New password',
      onSubmit(value) {
        const nextValue = String(value || '');
        if (!nextValue) {
          return;
        }
        if (!isConfirmation) {
          onPromptChange({
            ...prompt,
            field: 'confirmPassword',
            newPassword: nextValue,
            error: null
          });
          onInputChange('');
          return;
        }
        if (nextValue !== prompt.newPassword) {
          onPromptChange({
            ...prompt,
            error: 'Passwords do not match.'
          });
          onInputChange('');
          return;
        }
        onResolve({
          newPassword: prompt.newPassword,
          confirmPassword: nextValue
        });
      }
    })));
}

export function AuthDevicePrompt({
  prompt,
  onPromptChange,
  onResolve,
  onReject
}) {
  const devices = prompt.devices || [];
  const selectedIndex = prompt.selectedIndex || 0;

  useInput((input, key) => {
    if (key.escape) {
      onReject(new Error('Resource Optimiser authentication cancelled.'));
      return;
    }
    if (!devices.length) {
      return;
    }
    if (key.upArrow) {
      onPromptChange({
        ...prompt,
        selectedIndex: previousIndex(selectedIndex, devices.length)
      });
      return;
    }
    if (key.downArrow) {
      onPromptChange({
        ...prompt,
        selectedIndex: nextIndex(selectedIndex, devices.length)
      });
      return;
    }
    if (key.return) {
      onResolve(devices[selectedIndex]);
    }
  });

  return h(SelectionList, {
    title: 'Choose 2FA device · Esc cancel',
    items: devices.map((device, index) => ({
      key: String(device.id ?? device.value ?? index),
      label: device.label || `Device ${index + 1}`
    })),
    selectedIndex
  });
}

export function AuthOtpPrompt({
  inputValue = '',
  onInputChange,
  onResolve,
  onReject
}) {
  useInput((input, key) => {
    if (key.escape) {
      onReject(new Error('Resource Optimiser authentication cancelled.'));
    }
  });

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1
  },
  h(Text, { color: 'cyan' }, 'Enter 2FA code'),
  h(Text, { color: 'gray' }, 'Esc cancels. Code is not stored.'),
  h(Box, null,
    h(Text, { color: 'cyan' }, '2FA › '),
    h(TextInput, {
      value: inputValue,
      onChange: onInputChange,
      mask: '•',
      placeholder: '2FA code',
      onSubmit(value) {
        const otp = String(value || '').trim();
        if (otp) {
          onResolve(otp);
        }
      }
    })));
}

export function createInkCredentialProvider({
  resolverRef,
  rejecterRef,
  setAuthPrompt,
  setActivePanel,
  setInputValue,
  setSelectedIndex
}) {
  function openPrompt(prompt) {
    setInputValue('');
    setSelectedIndex(0);
    setAuthPrompt(prompt);
  }

  function waitForPrompt(prompt) {
    return new Promise((resolveValue, reject) => {
      resolverRef.current = resolveValue;
      rejecterRef.current = reject;
      openPrompt(prompt);
    });
  }

  return {
    async requestCredentials() {
      setActivePanel({
        kind: 'auth',
        title: 'Authentication',
        text: 'Enter Resource Optimiser email and password in the auth panel below.'
      });
      return waitForPrompt({
        step: 'credentials',
        field: 'email',
        email: ''
      });
    },

    async requestPasswordUpdate() {
      setActivePanel({
        kind: 'auth',
        title: 'Password update required',
        text: 'Keycloak requires a new Resource Optimiser password before login can continue.'
      });
      return waitForPrompt({
        step: 'password-update',
        field: 'newPassword',
        newPassword: '',
        error: null
      });
    },

    async requestDeviceSelection(devices) {
      if (!Array.isArray(devices) || devices.length === 0) {
        return null;
      }
      if (devices.length === 1) {
        return devices[0];
      }
      setActivePanel({
        kind: 'auth',
        title: 'Authentication',
        text: 'Choose the 2FA device in the auth panel below.'
      });
      return waitForPrompt({
        step: 'device',
        devices,
        selectedIndex: 0
      });
    },

    async requestOtp() {
      setActivePanel({
        kind: 'auth',
        title: 'Authentication',
        text: 'Enter the 2FA code in the auth panel below.'
      });
      return waitForPrompt({
        step: 'otp'
      });
    }
  };
}
