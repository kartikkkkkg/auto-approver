export const cfg = {
  urls: {
    // Change this to your actual portal URL (the link that opens as Kartik)
    homeNoelle: "https://<your-noelle-url-here>",
    searchPage: ""
  },

  // how many IDs to approve per batch
  batchSize: 25,

  sel: {
    // SWITCH USER
    activeUserText: "You are viewing Workforce Management as",
    switchLink: "text=Switch",
    switchDialogTitle: "Switch View",
    switchOption: (who) => `text="${who}"`,
    switchConfirm: 'button:has-text("Switch")',

    // SEARCH
    searchInput: 'input[placeholder*="Search by request ID"]',
    searchBtn: 'button:has(svg)',

    // RESULTS & CHECKBOXES
    rowById: (id) => `tr:has(a:has-text("${id}")), li:has-text("${id}")`,
    rowCheckbox: (id) =>
      `tr:has(a:has-text("${id}")) input[type="checkbox"], li:has-text("${id}") input[type="checkbox"]`,

    // BULK APPROVE
    bulkApproveBtn: 'button:has-text("Approve")',

    // confirmation modal
    approveConfirmBtn: 'button:has-text("Confirm")',

    // success feedback
    successToast:
      'div[role="status"], div.toast-success, text=successfully'
  },

  users: {
    kartik: "Gupta, Kartik",
    noelle: "Eder, Noelle",
    alvaro: "Garrido, Alvaro"
  },

  // your Windows username (for Edge)
  edgeProfileUser: "2031146"
};
