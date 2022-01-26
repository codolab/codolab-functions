'use strict';

const functions = require('firebase-functions');
const mkdirp = require('mkdirp');
const admin = require('firebase-admin');
admin.initializeApp();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');
const nanoid = require('nanoid')
const Paysera = require('paysera-nodejs');
const customAlphabet = require('nanoid');

// Max height and width of the thumbnail in pixels.
const THUMB_MAX_HEIGHT = 800;
const THUMB_MAX_WIDTH = 800;
// Thumbnail prefix added to file names.
const THUMB_PREFIX = 'thumb_';

var options = {
    projectid: '224050',
    sign_password: '07a2470081a8add64439de078c6a974b',
    accepturl: '/order-confirmation',
    cancelurl: '/order-page',
    callbackurl: 'https://us-central1-next-typescript-f0ae2.cloudfunctions.net/acceptCallback',
    test: 0,
};

/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 * After the thumbnail has been generated and uploaded to Cloud Storage,
 * we write the public URL to the Firebase Realtime Database.
 */
exports.generateThumbnail = functions.
    runWith({
        // Ensure the function has enough memory and time
        // to process large files
        timeoutSeconds: 300,
        memory: "1GB",
    }).
    storage.object().onFinalize(async (object) => {
        // File and directory paths.
        const filePath = object.name;
        const contentType = object.contentType; // This is the image MIME type
        const fileDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
        const tempLocalFile = path.join(os.tmpdir(), filePath);
        const tempLocalDir = path.dirname(tempLocalFile);
        const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

        // Exit if this is triggered on a file that is not an image.
        if (!contentType.startsWith('image/')) {
            return functions.logger.log('This is not an image.');
        }

        // Exit if the image is already a thumbnail.
        if (fileName.startsWith(THUMB_PREFIX)) {
            return functions.logger.log('Already a Thumbnail.');
        }

        // Cloud Storage files.
        const bucket = admin.storage().bucket(object.bucket);
        const file = bucket.file(filePath);
        const thumbFile = bucket.file(thumbFilePath);
        const metadata = {
            contentType: contentType,
            // To enable Client-side caching you can set the Cache-Control headers here. Uncomment below.
            // 'Cache-Control': 'public,max-age=3600',
        };

        // Create the temp directory where the storage file will be downloaded.
        await mkdirp(tempLocalDir)
        // Download file from bucket.
        await file.download({ destination: tempLocalFile });
        functions.logger.log('The file has been downloaded to', tempLocalFile);
        // Generate a thumbnail using ImageMagick.
        await spawn('convert', [tempLocalFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile], { capture: ['stdout', 'stderr'] });
        functions.logger.log('Thumbnail created at', tempLocalThumbFile);
        // Uploading the Thumbnail.
        await bucket.upload(tempLocalThumbFile, { destination: `thumbnails/${thumbFilePath}`, metadata: metadata });
        functions.logger.log('Thumbnail uploaded to Storage at', thumbFilePath);
        // Once the image has been uploaded delete the local files to free up disk space.
        fs.unlinkSync(tempLocalFile);
        fs.unlinkSync(tempLocalThumbFile);
        // Get the Signed URLs for the thumbnail and original image.
        const results = await Promise.all([
            thumbFile.getSignedUrl({
                action: 'read',
                expires: '03-01-2500',
            }),
            file.getSignedUrl({
                action: 'read',
                expires: '03-01-2500',
            }),
        ]);
        functions.logger.log('Got Signed URLs.');
        const thumbResult = results[0];
        const originalResult = results[1];
        const thumbFileUrl = thumbResult[0];
        const fileUrl = originalResult[0];
        // Add the URLs to the Database
        await admin.database().ref('images').push({ path: fileUrl, thumbnail: thumbFileUrl });
        return functions.logger.log('Thumbnail URLs saved to database.');
    });


exports.getPayseraPaymentUrl = functions.https.onRequest(async (req, res) => {
    console.log(req.body);
    console.log(req.params);
    const json = await req.json();
    const { email, finalPrice, name, surname } = json.query
    const paysera = new Paysera(options);
    console.log("Query", json.query);
    console.log("Params", json.params);


    const nanoid = customAlphabet('123456789ABCDEFGHIJKLMNPQRSTUVWXYZ', 6)
    const orderid = nanoid();
    console.log("Order ID", orderid);

    var params = {
        orderid: orderid,
        p_email: email,
        amount: finalPrice * 100,
        currency: 'EUR',
        p_firstname: name,
        p_lastname: surname
    };
    return paysera.buildRequestUrl(params)
});

exports.acceptCallback = functions.https.onRequest((req, res) => {

    // console.log(req)
    // var request = { data: ..., ss1: ... }; // the request data you got from paysera callback
    try {
        const paysera = new Paysera(options);
        console.log("req.ss1", req.query);

        var isValid = paysera.checkCallback(req.query);
        if (isValid) {
            // Since callback seems valid decode callback data
            var order = paysera.decode(req.query.data);
            // Your code ... to update order status
            console.log("order", order);

            admin.firestore().collection("Payments").doc(order.orderid).set({
                paid: true,
                // 'description': description,
                order
            }, { merge: true });

            // Don't forget to return "OK" as the response.
            return 'OK'
        } else {
            const error = "The callback is not valid.";
            return functions.logger.error(error);
        }
    } catch (error) {
        return functions.logger.error(error);
    }
})

// exports.createNewOrder = functions.https.onRequest((req, res) => {
//     const { email, finalPrice, name, surname } = req.query
//     const paysera = new Paysera(options);
//     console.log("Amount", req.query);


//     const nanoid = customAlphabet('123456789ABCDEFGHIJKLMNPQRSTUVWXYZ', 6)
//     const orderid = nanoid();
//     console.log("Order ID", orderid);

//     var params = {
//         orderid: orderid,
//         p_email: email,
//         amount: finalPrice * 100,
//         currency: 'EUR',
//         p_firstname: name,
//         p_lastname: surname
//     };
//     return paysera.buildRequestUrl(params)
// });

