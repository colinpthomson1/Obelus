import React, { useState, useRef, useEffect, useCallback } from 'react';
import { toast } from 'react-toastify';
import { errorMessage } from '../../utils/conversionUtils';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  enterText: {
    id: 'inlineEditText.enterText',
    defaultMessage: 'Enter text',
  },
  failedToSave: {
    id: 'inlineEditText.failedToSave',
    defaultMessage: 'Failed to save',
  },
  clickToEdit: {
    id: 'inlineEditText.clickToEdit',
    defaultMessage: 'Click to edit',
  },
  doubleClickToEdit: {
    id: 'inlineEditText.doubleClickToEdit',
    defaultMessage: 'Double-click to edit',
  },
});

interface InlineEditTextProps {
  value: string;
  onSave: (newValue: string) => Promise<void>;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  editClassName?: string;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onActivate?: () => void;
  ariaCurrent?: React.AriaAttributes['aria-current'];
  allowEmpty?: boolean;
  singleClickEdit?: boolean;
}

export const InlineEditText: React.FC<InlineEditTextProps> = ({
  value,
  onSave,
  maxLength = 200,
  placeholder,
  disabled = false,
  className = '',
  editClassName = '',
  onEditStart,
  onEditEnd,
  onActivate,
  ariaCurrent,
  allowEmpty = false,
  singleClickEdit = true,
}) => {
  const intl = useIntl();
  const resolvedPlaceholder = placeholder ?? intl.formatMessage(i18n.enterText);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<globalThis.HTMLButtonElement>(null);
  const restoreFocusAfterEdit = useRef(false);
  const originalValue = useRef(value);

  useEffect(() => {
    if (!isEditing) {
      setEditValue(value);
      originalValue.current = value;
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing && restoreFocusAfterEdit.current) {
      restoreFocusAfterEdit.current = false;
      viewRef.current?.focus();
    }
  }, [isEditing]);

  const handleStartEdit = useCallback(() => {
    if (disabled || isSaving) return;
    restoreFocusAfterEdit.current = true;
    setIsEditing(true);
    setEditValue(value);
    onEditStart?.();
  }, [disabled, isSaving, value, onEditStart]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditValue(originalValue.current);
    onEditEnd?.();
  }, [onEditEnd]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;

    const trimmedValue = editValue.trim();

    // Check if value unchanged
    if (trimmedValue === originalValue.current) {
      handleCancel();
      return;
    }

    // Check if empty when not allowed
    if (!allowEmpty && !trimmedValue) {
      handleCancel();
      return;
    }

    setIsSaving(true);
    try {
      await onSave(trimmedValue);
      originalValue.current = trimmedValue;
      setIsEditing(false);
      onEditEnd?.();
    } catch (error) {
      const errMsg = errorMessage(error, intl.formatMessage(i18n.failedToSave));
      console.error('InlineEditText save error:', errMsg);
      toast.error(errMsg);
      setEditValue(originalValue.current);
      handleCancel();
    } finally {
      setIsSaving(false);
    }
  }, [editValue, isSaving, allowEmpty, onSave, handleCancel, onEditEnd, intl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !isSaving) {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape' && !isSaving) {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSave, handleCancel, isSaving]
  );

  const handleBlur = useCallback(() => {
    if (!isSaving) {
      handleSave();
    }
  }, [handleSave, isSaving]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (singleClickEdit) {
        e.stopPropagation();
        handleStartEdit();
      } else {
        onActivate?.();
      }
    },
    [singleClickEdit, handleStartEdit, onActivate]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!singleClickEdit) {
        e.stopPropagation();
        handleStartEdit();
      }
    },
    [singleClickEdit, handleStartEdit]
  );

  const handleViewKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'F2' && !disabled) {
        e.preventDefault();
        e.stopPropagation();
        handleStartEdit();
      }
    },
    [disabled, handleStartEdit]
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        maxLength={maxLength}
        placeholder={resolvedPlaceholder}
        disabled={isSaving}
        className={`
          w-full px-2 py-1 border rounded
          bg-background-primary text-text-primary
          border-border-info ring-2 ring-ring-primary/20
          focus:outline-none focus:ring-2 focus:ring-ring-primary
          disabled:opacity-50 disabled:cursor-not-allowed
          ${editClassName}
        `}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <button
      ref={viewRef}
      type="button"
      className={`
        w-full cursor-pointer rounded border-0 bg-transparent px-2 py-1 text-left text-text-primary
        hover:bg-background-secondary
        transition-colors
        ${disabled ? 'opacity-60' : ''}
        ${className}
      `}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleViewKeyDown}
      aria-keyshortcuts={disabled ? undefined : 'F2'}
      aria-current={ariaCurrent}
      title={
        disabled
          ? ''
          : singleClickEdit
            ? intl.formatMessage(i18n.clickToEdit)
            : intl.formatMessage(i18n.doubleClickToEdit)
      }
    >
      {value || <span className="italic text-text-tertiary">{resolvedPlaceholder}</span>}
    </button>
  );
};
