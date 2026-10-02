// Package shim sends Web Push messages from let-go, over
// github.com/SherClockHolmes/webpush-go.
//
// No generated bindings: the library's one entry point,
// SendNotification(message, *Subscription, *Options), takes two
// structs, and lgx runs lginterop with -opaque-structs, so let-go has no
// way to build either. Send takes plain strings and builds them here.
//
// It knows nothing about the app: which endpoints are acceptable, who
// gets rung and what happens to a dead subscription are quickmeet.push's
// business.
package shim

import (
	"errors"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/nooga/let-go/pkg/rt"
	"github.com/nooga/let-go/pkg/vm"
)

// sendTimeout bounds one request to a push service. The library's
// default client has none, and a sender left hanging holds a goroutine.
const sendTimeout = 10 * time.Second

var client = &http.Client{Timeout: sendTimeout}

// GenerateVAPIDKeys returns a new VAPID key pair as one string: the
// private key, a space, the public key, both unpadded base64url. One
// string, so the pair is stored in one row and cannot be half-written.
func GenerateVAPIDKeys() (string, error) {
	private, public, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return "", err
	}
	return private + " " + public, nil
}

// Send encrypts payload for the subscription (endpoint, p256dh, auth, as
// the browser's PushSubscription.toJSON() gives them) and posts it to
// the push service. subject is the VAPID JWT's sub: an https: URL, or an
// address the library prefixes with mailto:. topic, if not empty, lets a
// newer message replace one still waiting at the push service; ttl is
// how long, in seconds, the service may hold it.
//
// It returns the push service's HTTP status, and an error only when
// nothing was sent: a key that does not decode, an encryption failure,
// no connection, a timeout.
func Send(endpoint, p256dh, auth, payload, subject, publicKey, privateKey, topic string, ttl int) (int, error) {
	if endpoint == "" {
		return 0, errors.New("no endpoint")
	}
	res, err := webpush.SendNotification([]byte(payload),
		&webpush.Subscription{
			Endpoint: endpoint,
			Keys:     webpush.Keys{P256dh: p256dh, Auth: auth},
		},
		&webpush.Options{
			HTTPClient:      client,
			Subscriber:      strings.TrimPrefix(subject, "mailto:"),
			Topic:           topic,
			TTL:             ttl,
			Urgency:         webpush.UrgencyHigh,
			VAPIDPublicKey:  publicKey,
			VAPIDPrivateKey: privateKey,
		})
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	return res.StatusCode, nil
}

// init registers the namespace directly rather than through
// rt.RegisterInstaller: pkg/rt drains its installer queue during its own
// package init, which Go runs before this one, so anything queued from
// here would never run (the livekit shim has the same note).
func init() {
	ns := vm.NewNamespace("webpush.shim")
	ns.Def("GenerateVAPIDKeys", vm.MustBox(GenerateVAPIDKeys))
	ns.Def("Send", vm.MustBox(Send))
	rt.RegisterNS(ns)
}
