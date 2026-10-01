import java.io.FileInputStream;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Base64;

/**
 * Print the SPKI SHA-256 pin of a certificate.
 *
 * The build runs this against the certificate it is about to bundle, and writes
 * the result into the generated Config class. That is deliberate: the pin and the
 * trust anchor are then derived from one input, so they cannot drift apart — a
 * pin that disagreed with the bundled certificate would be a connection failure
 * that only shows up on the phone.
 *
 * Run with a single-file source launch (JDK 11+):
 *   java tools/PinTool.java app/res/raw/pulse_ca.crt
 */
public final class PinTool {

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: java PinTool.java <certificate.pem>");
            System.exit(2);
        }
        try (FileInputStream in = new FileInputStream(args[0])) {
            X509Certificate certificate = (X509Certificate) CertificateFactory
                    .getInstance("X.509").generateCertificate(in);
            byte[] spki = MessageDigest.getInstance("SHA-256")
                    .digest(certificate.getPublicKey().getEncoded());
            System.out.println(Base64.getEncoder().encodeToString(spki));
        }
    }

    private PinTool() {}
}
