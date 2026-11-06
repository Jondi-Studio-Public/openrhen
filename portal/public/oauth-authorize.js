// Sign-in on the OAuth consent page: enrol this browser, then reload to see the consent screen.
(function () {
  var form = document.getElementById("sign-in");
  var error = document.getElementById("sign-in-error");
  if (!form) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var secret = form.elements.secret.value.trim();
    var show = function (message) {
      error.textContent = message;
      error.hidden = false;
    };
    fetch("/api/owner/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secret ? { secret: secret } : {})
    })
      .then(function (response) {
        if (response.ok) return window.location.reload();
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            show(body.error || "This browser could not be signed in.");
          });
      })
      .catch(function () {
        show("Could not reach OpenRhen to sign in. Check that it is running and your connection, then try again.");
      });
  });
})();
