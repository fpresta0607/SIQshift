interface UpdateFailingNoticeProps {
  isMacos: boolean;
}

/**
 * Shown once this copy's update attempts have failed several times in a row,
 * so it would otherwise stay on its old build without saying so. A single
 * failed check never shows it, and the next successful check takes it down.
 */
export const UpdateFailingNotice = ({ isMacos }: UpdateFailingNoticeProps) => (
  <p className="update-failing-notice" role="status" data-testid="update-failing">
    SIQshift can&apos;t update itself, so it is staying on this version. Download the newest version from
    siqshift.siqstack.com
    {isMacos ? ", drag it into your Applications folder in Finder, and open it from there." : " and run the installer."}
  </p>
);
