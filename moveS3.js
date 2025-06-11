const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();
const AWS = require('aws-sdk');

const API_BASE_URL = 'http://localhost:3000';
const BUCKET_NAME = process.env.AWS_S3_BUCKET;

// AWS S3 Setup
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Firebase Init
if (!admin.apps.length) {
  const credentials = JSON.parse(process.env.CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
    databaseURL: `https://${credentials.project_id}-default-rtdb.firebaseio.com/`
  });
}

// Token generator
const getBearerTokenForUser = async (uid) => {
  try {
    const customToken = await admin.auth().createCustomToken(uid);
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.API_KEY}`,
      { token: customToken, returnSecureToken: true }
    );
    return `Bearer ${response.data.idToken}`;
  } catch (error) {
    console.error(`❌ Token error for ${uid}:`, error.response?.data || error.message);
    return null;
  }
};

// Get owned projects
const getUserOwnedProjects = async (userId, token) => {
  try {
    const res = await axios.post(`${API_BASE_URL}/api/v1/project/getAllUserOwnedProjects`, { userId }, {
      headers: { Authorization: token }
    });
   
    return res.data.data.response || [];
  } catch (error) {
    console.error(`❌ Failed to fetch projects for ${userId}:`, error.response?.data || error.message);
    return [];
  }
};

// Get branches
const getAllBranches = async (projectData, token) => {
  try {
    const projectId = projectData.projectId;
    const userId = projectData.userId;

    const res = await axios.post(
      `${API_BASE_URL}/api/v1/branches/getByProjectId`,
      { projectId },
      {
        headers: {
          Authorization: token,
          projectId: projectId
        }
      }
    );

    const data = res.data.data.response || [];

 for (const item of data) {
  const branchId = item.branchId || item.id;

  const oldKey = `${process.env.DIGIA_PUBLIC_PATH}/${userId}/${projectId}/functions/${branchId}.js`;
  const newKey = `${process.env.DIGIA_PUBLIC_PATH}/${projectId}/branches/${branchId}/function.js`;

  console.log(`🔍 Checking newKey existence: ${newKey}`);

  try {
    // Check if newKey already exists
    await s3.headObject({
      Bucket: BUCKET_NAME,
      Key: newKey,
    }).promise();

    console.warn(`⚠️ Skipped ${newKey} — already exists.`);
    continue; // Skip to next item
  } catch (headErr) {
    if (headErr.code !== 'NotFound') {
      console.warn(`⚠️ Failed to check existence of ${newKey}:`, headErr.message);
      continue;
    }
    // If NotFound → continue to fetch oldKey
  }

  try {
    const oldFile = await s3.getObject({
      Bucket: BUCKET_NAME,
      Key: oldKey
    }).promise();

    await s3.putObject({
      Bucket: BUCKET_NAME,
      Key: newKey,
      Body: oldFile.Body,
      ContentType: 'application/javascript'
    }).promise();

    console.log(`✅ Migrated ${oldKey} → ${newKey}`);
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      console.warn(`⚠️ Skipped ${oldKey} — file does not exist.`);
    } else {
      console.warn(`⚠️ Could not migrate ${oldKey}:`, err.message);
    }
    continue;
  }
}

    return data;
  } catch (error) {
    console.error(`❌ Failed to fetch branches for project ${projectData.projectId}:`, error.response?.data || error.message);
    return [];
  }
};


// Get functions
const allFunctionsOfProject = async (projectId, token, userId, branchId) => {
  try {
    const res = await axios.post(`${API_BASE_URL}/api/v1/functions/getAll`, {branchId}, {
      headers: {
        Authorization: token,
        projectid: projectId
      }
    });

    const functions = res.data.data.response || [];
   

  
  } catch (error) {
    console.error(`❌ Error fetching functions for project ${projectId}:`, error.response?.data || error.message);
    return [];
  }
};

// Get data sources
// const getAllDataSources = async (projectId, token,branchId) => {
//   try {
//     const res = await axios.post(`${API_BASE_URL}/api/v1/dataSource/project`, { projectId ,branchId}, {
//       headers: { Authorization: token }
//     });
   
//     const data =  res.data.data.response || [];
//     if(data.mock)
//     {
//       const oldFilePath = `${projectId}/${branchId}/dataSources/mock.json`;
//       const newFilePath = `${projectId}/${branchId}/dataSources/mock.json`;
//     }
//   } catch (error) {
//     console.error(`❌ Failed to fetch data sources for project ${projectId}:`, error.response?.data || error.message);
//     return [];
//   }
// };

const getAllVersions = async (projectData, token) => {
  try {
    const res = await axios.post(`${API_BASE_URL}/api/v1/version/getAll`, { projectId: projectData.projectId }, {
      headers: { Authorization: token, projectid: projectData.projectId }
    });

    const versions = res.data.data.response || [];

    for (const version of versions) {
      const versionStr = version.version || version;

      const oldVersionFilePath = `${process.env.DIGIA_PUBLIC_PATH}/${projectData.userId}/${projectData.projectId}/functions/functions_v${versionStr}.js`;
      const oldAppConfigFilePath = `${process.env.DIGIA_PUBLIC_PATH}/${projectData.userId}/${projectData.projectId}/appconfig/appconfig_v${versionStr}.json`;

      const newVersionFilePath = `${process.env.DIGIA_PUBLIC_PATH}/${projectData.projectId}/versions/${versionStr}/functions.js`;
      const newAppConfigFilePath = `${process.env.DIGIA_PUBLIC_PATH}/${projectData.projectId}/versions/${versionStr}/appconfig.json`;

      // ─────────────────────────────
      // Migrate Function File
      // ─────────────────────────────
      try {
        await s3.headObject({ Bucket: BUCKET_NAME, Key: newVersionFilePath }).promise();
        console.warn(`⚠️ Skipped function.js for version ${versionStr} — already exists.`);
      } catch (headErr) {
        if (headErr.code === 'NotFound') {
          try {
            const oldFunctionFile = await s3.getObject({
              Bucket: BUCKET_NAME,
              Key: oldVersionFilePath
            }).promise();

            await s3.putObject({
              Bucket: BUCKET_NAME,
              Key: newVersionFilePath,
              Body: oldFunctionFile.Body,
              ContentType: 'application/javascript'
            }).promise();

            console.log(`✅ Migrated function: ${oldVersionFilePath} → ${newVersionFilePath}`);
          } catch (getErr) {
            if (getErr.code === 'NoSuchKey') {
              console.warn(`⚠️ Skipped function file — ${oldVersionFilePath} does not exist.`);
            } else {
              console.warn(`⚠️ Failed to migrate function file ${oldVersionFilePath}:`, getErr.message);
            }
          }
        } else {
          console.warn(`⚠️ Could not check existence of ${newVersionFilePath}:`, headErr.message);
        }
      }

      // ─────────────────────────────
      // Migrate AppConfig File
      // ─────────────────────────────
      try {
        await s3.headObject({ Bucket: BUCKET_NAME, Key: newAppConfigFilePath }).promise();
        console.warn(`⚠️ Skipped appconfig.json for version ${versionStr} — already exists.`);
      } catch (headErr) {
        if (headErr.code === 'NotFound') {
          try {
            const oldAppConfigFile = await s3.getObject({
              Bucket: BUCKET_NAME,
              Key: oldAppConfigFilePath
            }).promise();

            await s3.putObject({
              Bucket: BUCKET_NAME,
              Key: newAppConfigFilePath,
              Body: oldAppConfigFile.Body,
              ContentType: 'application/json'
            }).promise();

            console.log(`✅ Migrated app config: ${oldAppConfigFilePath} → ${newAppConfigFilePath}`);
          } catch (getErr) {
            if (getErr.code === 'NoSuchKey') {
              console.warn(`⚠️ Skipped app config — ${oldAppConfigFilePath} does not exist.`);
            } else {
              console.warn(`⚠️ Failed to migrate app config file ${oldAppConfigFilePath}:`, getErr.message);
            }
          }
        } else {
          console.warn(`⚠️ Could not check existence of ${newAppConfigFilePath}:`, headErr.message);
        }
      }
    }

    return versions;
  } catch (error) {
    console.error(`❌ Failed to fetch versions for project ${projectData.projectId}:`, error.response?.data || error.message);
    return [];
  }
};




// ─── CLI RUNNER ──────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    try {
      const users = [{
        displayName: "Admin",
        email: "choubeyaditya80@gmail.com",
        uid: 'fdtG1LfPbJXQzDnDnOtyjCykZtD2'
      }];

      for (const user of users) {
        console.log(`\n🔑 User: ${user.email} (${user.uid})`);

        const token = await getBearerTokenForUser(user.uid);
        if (!token) continue;

        // const projects = await getUserOwnedProjects(user.uid, token);
       const projects = {
        projects: [
      {
      projectId: "664e56045695adc5c7edf912",
      userId: "fdtG1LfPbJXQzDnDnOtyjCykZtD2",
      appDetails: {
        name: "Bytes Template",
        packageValue: "com.bytes.template",
        displayName: "Bytes Template",
      },
      createdAt: "2024-04-23T14:33:25.867Z",
      updatedAt: "2024-04-23T14:33:25.867Z",
      media: {
        iconUrl: {
          type: "",
          baseUrl: "",
          path: "",
        },
        splashUrl: {
          type: "",
          baseUrl: "",
          path: "",
        },
      },
      createdBy: "duesexodus",
      totalMembers: 1,
    }
  ]
};

      

        for (const project of projects.projects) {
          console.log(`\n📦 Project: ${project.name} (${project.projectId})`);

          const versions = await getAllVersions(project, token);

          const branches = await getAllBranches(project, token);

        }
      }

      process.exit(0);
    } catch (error) {
      console.error("❌ Fatal script error:", error);
      process.exit(1);
    }
  })();
}
