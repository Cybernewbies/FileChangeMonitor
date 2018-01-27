// grab the mongoose module
let paranoid = require("paranoid-request");
let mongoose = require('mongoose');
let jsdiff = require('diff');
let AWS = require('aws-sdk');
let s3 = new AWS.S3();
var Promise = require("bluebird");

const FileSchema = new mongoose.Schema({
  url: String,
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

// FileSchema.path('name').validate(function(name) {
//   if (name == '') return false;
//   return true;
// }, 'The name is not valid.');

FileSchema.methods = {
  getFilteredFileUrl() {
      return this.id.replace(/\W/g, '');
  },
  // returns a promise of the contents of the remotely stored file
  // TODO: actually return a promise?
  getRemoteContents(error, success) {
      this.bulkReadFromBucket([{
          key: this.getFilteredFileUrl()
      }, {
          key: 'diff-' + this.getFilteredFileUrl()
      }, {
          key: 'urls-' + this.getFilteredFileUrl()
      }, {
          key: 'urls-diff-' + this.getFilteredFileUrl()
      }], (err) => {
          error(err);
      }, (data) => {
          success(data);
      });
  },
  // returns contents of arrays of files
  bulkReadFromBucket(keyArray, error, success) {
      let keyObject = keyArray.pop();
      s3.getObject({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: keyObject.key,
      }, (err, response) => {
          let responseConstruct = {};
          if (response && response.Body) {
              responseConstruct = response.Body.toString('utf8');
          }
          if (err || !response || !response.Body) {
              responseConstruct = { error: err }; //fail silently
          }
          if (keyArray.length > 0) {
              this.bulkReadFromBucket(keyArray, error, (responseArray) => {
                  success(responseArray.concat([responseConstruct]))
              });
          } else {
              success([responseConstruct]);
          }
      });
  },
  // writes an array of multiple data objects to the bucket
  bulkWriteToBucket(dataArray, error, success) {
      let dataObject = dataArray.pop();
      s3.putObject({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: dataObject.key,
          Body: dataObject.data
      }, (err, response) => {
          let responseConstruct = response;
          if (err) {
              responseConstruct = { error: err }; //fail silently
          }
          if (dataArray.length > 0) {
              this.bulkWriteToBucket(dataArray, error, (responseArray) => {
                  success(responseArray.concat(responseConstruct))
              });
          } else {
              success([responseConstruct]);
          }
      });
  },
  extractRelativeUrls(data) {
      let stringDelimiters = ['"', '\'', '`'];
      let urls = new Set();
      for (delimiter of stringDelimiters) {
          let segments = data.split(delimiter + '/');
          for (let i=1; i < segments.length; i++) { // begin at item 1
              let url = segments[i].substring(0, segments[i].indexOf(delimiter));
              urls.add('/' + url);
          }
      }
      return  Array.from(urls);
  },
  reloadFile(isNew, error, success) {
      paranoid.get(this.url, (err, res, newData) => {
          if (err) return error(err);
          if (isNew) {
              return this.bulkWriteToBucket([{
                  data: newData,
                  key: this.getFilteredFileUrl()
              }, {
                  data: this.extractRelativeUrls(newData).join('\n'),
                  key: 'urls-' + this.getFilteredFileUrl()
              }], (err) => {
                  console.log(err);
                  return error(err);
              }, (newData) => {
                  success(newData);
              });
          }
          this.getRemoteContents((err) => {
              return error(err);
          }, (originalDataArray) => {
              let originalData = originalDataArray[0] //TODO: check for error here
              if (typeof originalData !== 'string') originalData = '';
              if (newData == originalData) { // file has not been modified, return
                  console.log('File has not been modified.');
                  return success(originalData);
              }
              // file has been modified, diff the file

              let threshold = 0;
              let diff = jsdiff.diffLines(originalData, newData);
              let modifications = [];
              let numCharsModified = 0;
              for (let i=0; i < diff.length; i++) {
                  let part = diff[i];
                  if (part.added || part.removed) {
                      if (part.value.replace(/\s+/g, '') != '') { //string is not empty
                          modifications.push(part);
                          numCharsModified += part.count;
                      }
                  }
              }

              let originalUrls = originalDataArray[2]; // location of the url file
              if (typeof originalUrls !== 'string') originalUrls = '';
              let newUrls = this.extractRelativeUrls(newData).join('\n')
              let urlsDiff = jsdiff.diffLines(originalUrls, newUrls);
              if (modifications.length && numCharsModified > threshold) {
                  console.log("Modifications made, saving files.");
                  this.bulkWriteToBucket([{
                      data: newData,
                      key: this.getFilteredFileUrl()
                  }, {
                      data: JSON.stringify(diff),
                      key: 'diff-' + this.getFilteredFileUrl()
                  }, {
                      data: newUrls,
                      key: 'urls-' + this.getFilteredFileUrl()
                  }, {
                      data: JSON.stringify(urlsDiff),
                      key: 'urls-diff-' + this.getFilteredFileUrl()
                  }], (err) => {
                      return error(err);
                  }, (response) => {
                      success(response);
                  });
              }
          });
      });
  }
}

module.exports = mongoose.model('File', FileSchema);
