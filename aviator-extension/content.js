// This script runs INSIDE the Fortebet page
function scrapeBalance() {
    // We look for the specific HTML element that holds your UGX balance
    // Note: You may need to inspect the element on Fortebet to get the exact class name
    const balanceElement = document.querySelector('.user-balance') || document.querySelector('.balance-amount');
    
    if (balanceElement) {
        const balanceText = balanceElement.innerText.replace(/[^0-9.-]+/g,"");
        const balanceValue = parseFloat(balanceText);

        // Send this balance to your Python Server
        fetch("http://localhost:5000/balance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ balance: balanceValue })
        }).catch(() => {});
    }
}

// Scrape every 5 seconds to keep the Python server updated
setInterval(scrapeBalance, 5000);