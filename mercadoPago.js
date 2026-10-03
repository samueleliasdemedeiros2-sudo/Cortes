"use strict";

const crypto = require("crypto");

const MP_ACCESS_TOKEN =
    process.env.MP_ACCESS_TOKEN ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    "";

async function mercadoPagoRequest(endpoint, options = {}) {
    if (!MP_ACCESS_TOKEN) {
        throw new Error(
            "MP_ACCESS_TOKEN não configurado."
        );
    }

    const response = await fetch(
        `https://api.mercadopago.com${endpoint}`,
        {
            ...options,

            headers: {
                Authorization:
                    `Bearer ${MP_ACCESS_TOKEN}`,

                "Content-Type":
                    "application/json",

                ...(options.headers || {})
            },

            signal:
                AbortSignal.timeout(60000)
        }
    );

    const text = await response.text();

    let data;

    try {
        data = text
            ? JSON.parse(text)
            : null;
    } catch (_) {
        data = {
            raw: text
        };
    }

    if (!response.ok) {
        throw new Error(
            data?.message ||
            data?.error ||
            `Mercado Pago HTTP ${response.status}`
        );
    }

    return data;
}

async function criarPagamentoPix({
    amount,
    description,
    email,
    externalReference,
    notificationUrl
}) {
    const body = {
        transaction_amount:
            Number(
                Number(amount).toFixed(2)
            ),

        description:
            description ||
            "ClipForge Pro VIP",

        payment_method_id:
            "pix",

        payer: {
            email
        },

        external_reference:
            externalReference
    };

    if (notificationUrl) {
        body.notification_url =
            notificationUrl;
    }

    return mercadoPagoRequest(
        "/v1/payments",
        {
            method: "POST",

            headers: {
                "X-Idempotency-Key":
                    crypto.randomUUID()
            },

            body:
                JSON.stringify(body)
        }
    );
}

async function consultarPagamentoPix(
    paymentId
) {
    return mercadoPagoRequest(
        `/v1/payments/${encodeURIComponent(
            paymentId
        )}`,
        {
            method: "GET"
        }
    );
}

module.exports = {
    criarPagamentoPix,
    consultarPagamentoPix
};