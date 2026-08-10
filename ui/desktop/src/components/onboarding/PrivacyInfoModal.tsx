import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  title: {
    id: 'privacyInfoModal.title',
    defaultMessage: 'Privacy in this build',
  },
  description: {
    id: 'privacyInfoModal.description',
    defaultMessage:
      'Obelus product analytics are disabled. The application does not send usage events to a project-owned analytics service.',
  },
  whatWeCollect: {
    id: 'privacyInfoModal.whatWeCollect',
    defaultMessage: 'What may still leave this device:',
  },
  collectOs: {
    id: 'privacyInfoModal.collectOs',
    defaultMessage: 'Prompts and files you choose to send to a cloud model provider',
  },
  collectVersion: {
    id: 'privacyInfoModal.collectVersion',
    defaultMessage: 'Requests made by tools, extensions, and connected services',
  },
  collectProvider: {
    id: 'privacyInfoModal.collectProvider',
    defaultMessage: 'Information you explicitly share through session or recipe features',
  },
  neverCollect: {
    id: 'privacyInfoModal.neverCollect',
    defaultMessage:
      'Review each provider and extension policy before working with sensitive material. Local model inference keeps model requests on this device, but tools may still use the network.',
  },
});

interface PrivacyInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function PrivacyInfoModal({ isOpen, onClose }: PrivacyInfoModalProps) {
  const intl = useIntl();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[440px] max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle className="text-center">{intl.formatMessage(i18n.title)}</DialogTitle>
        </DialogHeader>

        <div>
          <p className="mb-3 text-sm text-text-secondary">{intl.formatMessage(i18n.description)}</p>
          <p className="mb-1.5 text-sm font-medium text-text-primary">
            {intl.formatMessage(i18n.whatWeCollect)}
          </p>
          <ul className="mb-3 ml-5 list-outside list-disc space-y-0.5 text-sm text-text-secondary">
            <li>{intl.formatMessage(i18n.collectOs)}</li>
            <li>{intl.formatMessage(i18n.collectVersion)}</li>
            <li>{intl.formatMessage(i18n.collectProvider)}</li>
          </ul>
          <p className="text-sm text-text-secondary">{intl.formatMessage(i18n.neverCollect)}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
