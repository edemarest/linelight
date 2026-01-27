"use client";

export const AppFooter = () => {
  return (
    <footer className="app-footer mt-0">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <span>© 2026 Ella Demarest · Personal project</span>
        <div className="flex items-center gap-3">
          <a
            className="icon-button"
            href="https://www.linkedin.com/in/ella-demarest-b48553189/"
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn"
            data-interactive="icon"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M19 3A2 2 0 0 1 21 5V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H19M8.5 17V10.5H6V17H8.5M7.25 9.5A1.25 1.25 0 0 0 7.25 7A1.25 1.25 0 0 0 7.25 9.5M18 17V13.25C18 11.5 17.6 10 15.75 10C14.75 10 14.1 10.55 13.75 11.1H13.7V10.5H11.3V17H13.8V13.75C13.8 12.9 13.95 12 14.95 12C15.95 12 16 12.9 16 13.8V17H18Z"
              />
            </svg>
          </a>
          <a
            className="icon-button"
            href="https://ellademarestportfolio.netlify.app/"
            target="_blank"
            rel="noreferrer"
            aria-label="Portfolio"
            data-interactive="icon"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M12 3A9 9 0 1 1 3 12A9 9 0 0 1 12 3M11 7V9H13V7H11M11 11V17H13V11H11Z"
              />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
};
